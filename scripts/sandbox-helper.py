#!/usr/bin/env python3
"""FilesDude's media sandbox helper: the one part of FilesDude that runs as root.

FilesDude itself runs as an ordinary account, so it can't start system units. To decode a video or
image (files other people control) it asks this helper, over a Unix socket only its account can
reach, to run ffmpeg, ffprobe, or Node.js and sharp in a throwaway systemd unit with a fixed,
locked-down profile: a temporary user, no network or sockets, no capabilities, a system-call filter,
memory, task, CPU, and time limits, and nothing of the filesystem beyond the system's programs and
libraries. FilesDude only says which of those three tools, its arguments, and how long it may run;
the profile, the paths, and what's hidden are decided here. The file to read (and, for a playable
copy, the file to write) arrive as already-opened files passed over the socket, never as paths.

The client (sandbox-client.py, started by FilesDude) sends a 4-byte length with the two open files
(its standard input and output), then the JSON request; this sends back the run's exit status as
a 4-byte number. A client that goes away stops its run.

Run by filesdude-sandbox.service (socket-activated), or with --socket PATH (tests). With
--print-args REQUEST it prints the systemd-run arguments a request would get, and exits.
"""

import json
import os
import pwd
import select
import socket
import struct
import subprocess
import sys
import threading
import time
import uuid

SYSTEMD_RUN = "/usr/bin/systemd-run"
SYSTEMCTL = "/usr/bin/systemctl"
ENV = "/usr/bin/env"
# Where host files shown to a sandbox appear in it (its /run is otherwise empty).
MOUNT_DIR = "/run/filesdude"
DEFAULT_SECONDS = 15
MAX_SECONDS = 600
MAX_FILE_SECONDS = 4 * 60 * 60
MAX_REQUEST_BYTES = 1024 * 1024
MAX_ARGS = 256
MAX_RUNNING = 16

SANDBOX = [
    "DynamicUser=yes", "PrivateNetwork=yes", "PrivateTmp=yes", "PrivateDevices=yes", "PrivateIPC=yes",
    "ProtectSystem=strict", "ProtectHome=yes", "ProtectProc=invisible", "ProcSubset=pid",
    "ProtectKernelTunables=yes", "ProtectKernelModules=yes", "ProtectKernelLogs=yes", "ProtectControlGroups=yes", "ProtectClock=yes", "ProtectHostname=yes",
    "NoNewPrivileges=yes", "CapabilityBoundingSet=", "RestrictAddressFamilies=AF_UNIX", "RestrictNamespaces=yes", "RestrictRealtime=yes", "RestrictSUIDSGID=yes",
    # No socket calls at all (systemd can't drop the last address family), so no host sockets either;
    # Node.js may only ask what its standard input and output are (see inspectSockets).
    "LockPersonality=yes", "SystemCallFilter=@system-service", "SystemCallFilter=~@network-io", "SystemCallArchitectures=native",
    # io_uring would let a compromised decoder do what the filter forbids (and is a common way to attack
    # the kernel); refused with an error, as Node.js tries it when it starts. After @system-service,
    # which would otherwise allow it again.
    "SystemCallFilter=~io_uring_setup:EPERM io_uring_enter:EPERM io_uring_register:EPERM",
    # No swap on top of the memory limit, and every run shares one slice's limits (see install.sh).
    "MemoryMax=512M", "MemorySwapMax=0", "TasksMax=64", "CPUQuota=200%", "Slice=filesdude-media.slice",
    # Its own small /dev/shm rather than the host's.
    "TemporaryFileSystem=/etc:ro /run:ro /dev/shm:size=16M", "BindReadOnlyPaths=-/etc/ld.so.cache -/etc/alternatives",
]

# Top-level folders the sandbox keeps: the system's programs and libraries (often symlinks into /usr),
# and the kernel and temporary filesystems the sandbox already replaces with its own.
KEPT = {"usr", "bin", "sbin", "lib", "lib32", "lib64", "libx32", "proc", "dev", "tmp", "etc", "run"}


def setting(name, default=""):
    return os.environ.get(name) or default


def hidden_paths():
    """Everything else at the top of the filesystem is hidden, whatever this host has there."""
    return sorted("/" + entry.name for entry in os.scandir("/") if not entry.is_symlink() and entry.name not in KEPT)


def quote(word):
    """systemd splits path lists on spaces, so a path with spaces or quotes is quoted and escaped."""
    if any(character in word for character in " \t\n\"'\\"):
        return '"' + word.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return word


def tool_command(tool):
    """The program for each tool FilesDude may ask for, and what it needs shown to it."""
    if tool == "ffmpeg":
        return [setting("FILEDUDE_FFMPEG_PATH", "/usr/bin/ffmpeg")], []
    if tool == "ffprobe":
        return [setting("FILEDUDE_FFPROBE_PATH", "/usr/bin/ffprobe")], []
    if tool == "node":
        # Node.js and FilesDude's packages (sharp) are shown read-only; systemd-run looks for the program
        # outside the sandbox, where a mounted one isn't, so env starts it (with no environment at all).
        node = os.path.realpath(setting("FILEDUDE_SANDBOX_NODE", "/opt/filesdude/node/bin/node"))
        modules = os.path.realpath(setting("FILEDUDE_SANDBOX_MODULES", "/opt/filesdude/current/node_modules"))
        return [ENV, "-i", MOUNT_DIR + "/node"], [(node, MOUNT_DIR + "/node"), (modules, MOUNT_DIR + "/node_modules")]
    raise ValueError("unknown tool")


def checked(request):
    """The request, checked: one of the three tools, plain arguments, and sensible limits."""
    if not isinstance(request, dict):
        raise ValueError("request must be an object")
    tool = request.get("tool")
    if tool not in ("ffmpeg", "ffprobe", "node"):
        raise ValueError("unknown tool")
    args = request.get("args")
    if not isinstance(args, list) or len(args) > MAX_ARGS or not all(isinstance(arg, str) for arg in args):
        raise ValueError("arguments must be a list of strings")
    # systemd would expand $VARIABLES in the command, changing it.
    if any("$" in arg or "\0" in arg for arg in args) or sum(len(arg) for arg in args) > MAX_REQUEST_BYTES:
        raise ValueError("arguments can't be used")
    file_output = request.get("fileOutput")
    if file_output is not None and (not isinstance(file_output, int) or isinstance(file_output, bool) or file_output < 1 or file_output > 2 ** 40):
        raise ValueError("invalid output limit")
    seconds = request.get("seconds", DEFAULT_SECONDS)
    if not isinstance(seconds, (int, float)) or isinstance(seconds, bool) or seconds != seconds:
        seconds = DEFAULT_SECONDS
    seconds = min(max(1, round(seconds)), MAX_FILE_SECONDS if file_output is not None else MAX_SECONDS)
    inspect = request.get("inspectSockets") is True
    return {"tool": tool, "args": args, "seconds": seconds, "fileOutput": file_output, "inspectSockets": inspect}


def unit_arguments(request, unit):
    """systemd-run's arguments for one run of a checked request, as the unit with this name."""
    command, mounts = tool_command(request["tool"])
    seconds = request["seconds"]
    properties = list(SANDBOX)
    if request["inspectSockets"]:
        properties.append("SystemCallFilter=getsockname getsockopt")
    if request["fileOutput"] is not None:
        # The kernel refuses writes past the limit; reserving space and resizing aren't allowed at all.
        properties += ["LimitFSIZE=%d" % request["fileOutput"], "SystemCallFilter=~fallocate ftruncate"]
    # Runs stop when FilesDude stops or restarts (a new FilesDude wouldn't know about them).
    bound = os.environ.get("FILEDUDE_SANDBOX_BIND", "filesdude.service")
    if bound:
        properties.append("BindsTo=" + bound)
    properties.append("RuntimeMaxSec=%d" % seconds)
    # Long runs read whole videos; they yield the disk to everything else.
    if seconds > DEFAULT_SECONDS:
        properties += ["IOWeight=10", "CPUWeight=20"]
    if mounts:
        properties.append("BindReadOnlyPaths=" + " ".join(quote(host) + ":" + quote(inside) for host, inside in mounts))
    # Wherever the data root and state folder are, they are out of reach too.
    out_of_reach = hidden_paths() + [os.path.abspath(path) for path in (setting("FILEDUDE_ROOT"), setting("FILEDUDE_STATE_DIR")) if path]
    properties.append("InaccessiblePaths=" + " ".join(quote("-" + path) for path in out_of_reach))
    arguments = ["--pipe", "--wait", "--quiet", "--collect", "--service-type=exec", "--unit=" + unit]
    for item in properties:
        arguments += ["-p", item]
    return arguments + command + request["args"]


def receive_exactly(connection, length):
    data = b""
    while len(data) < length:
        chunk = connection.recv(min(65536, length - len(data)))
        if not chunk:
            raise ConnectionError("closed")
        data += chunk
    return data


def reply(connection, code):
    try:
        connection.sendall(struct.pack("!i", code))
    except OSError:
        pass


def stop_unit(unit):
    subprocess.run([SYSTEMCTL, "stop", unit], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60, check=False)


def run(request, files, connection):
    """Runs the request with these open files as its input and output; the client leaving stops it."""
    unit = "filesdude-media-" + str(uuid.uuid4())
    try:
        process = subprocess.Popen([SYSTEMD_RUN] + unit_arguments(request, unit), stdin=files[0], stdout=files[1], stderr=subprocess.DEVNULL, close_fds=True)
    finally:
        for descriptor in files:
            os.close(descriptor)
    # A backstop in case systemd's own time limit doesn't stop it.
    deadline = time.monotonic() + request["seconds"] + 10
    stopped = False
    while process.poll() is None:
        readable, _, _ = select.select([connection], [], [], 0.5)
        # The client sends nothing more, so anything readable means it has gone.
        gone = bool(readable) and not connection.recv(1, socket.MSG_PEEK)
        if gone or time.monotonic() > deadline:
            stopped = True
            stop_unit(unit)
            process.kill()
            process.wait()
            break
    return 124 if stopped else process.returncode


def serve(connection, allowed, slots):
    files = []
    try:
        _, uid, _ = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
        if uid not in allowed:
            return
        # A request arrives all at once; a connection that sends nothing doesn't keep a thread.
        connection.settimeout(10)
        header, files, _, _ = socket.recv_fds(connection, 4, 2)
        if len(header) != 4 or len(files) != 2:
            return
        (length,) = struct.unpack("!I", header)
        if length > MAX_REQUEST_BYTES:
            return
        request = checked(json.loads(receive_exactly(connection, length)))
        connection.settimeout(None)
        if not slots.acquire(blocking=False):
            reply(connection, 75)
            return
        try:
            handed, files = files, []
            reply(connection, run(request, handed, connection))
        finally:
            slots.release()
    except (ValueError, ConnectionError, OSError, json.JSONDecodeError):
        reply(connection, 64)
    finally:
        for descriptor in files:
            try:
                os.close(descriptor)
            except OSError:
                pass
        connection.close()


def allowed_accounts():
    """Root (tests) and FilesDude's own account may ask for runs."""
    allowed = {0}
    try:
        allowed.add(pwd.getpwnam(setting("FILEDUDE_SANDBOX_USER", "filesdude")).pw_uid)
    except KeyError:
        pass
    return allowed


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--print-args":
        print(json.dumps(unit_arguments(checked(json.loads(sys.argv[2])), "filesdude-media-example")))
        return
    if len(sys.argv) == 3 and sys.argv[1] == "--socket":
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        if os.path.exists(sys.argv[2]):
            os.unlink(sys.argv[2])
        server.bind(sys.argv[2])
        os.chmod(sys.argv[2], 0o600)
        server.listen(64)
    elif os.environ.get("LISTEN_FDS") == "1" and os.environ.get("LISTEN_PID") == str(os.getpid()):
        server = socket.socket(fileno=3)
    else:
        sys.exit("usage: sandbox-helper.py --socket PATH | --print-args REQUEST (or socket activation)")
    allowed = allowed_accounts()
    slots = threading.BoundedSemaphore(MAX_RUNNING)
    while True:
        connection, _ = server.accept()
        threading.Thread(target=serve, args=(connection, allowed, slots), daemon=True).start()


if __name__ == "__main__":
    main()
