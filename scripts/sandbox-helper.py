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

In FilesDude's Docker image, which has no systemd, the container's entrypoint (docker/filesdude.mjs)
starts it as root with --container SOCKET UID GID instead, and it starts each run itself (see "Without
systemd" below). --print-container REQUEST prints what such a run would get, and exits.
"""

import ctypes
import errno
import grp
import json
import math
import os
import pwd
import re
import select
import signal
import socket
import stat
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
# Connections beyond this are closed straight away, so nothing can make the helper run out of threads.
MAX_CONNECTIONS = 48
# A request waits this long for one of the running slots before it's turned away.
SLOT_WAIT_SECONDS = 60

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
    "TemporaryFileSystem=/run:ro /dev/shm:size=16M",
]

# Its /etc holds only what the dynamic linker needs, mounted onto empty placeholders in a folder the
# installer makes: where SELinux is on, systemd can't make them in an empty in-memory /etc.
ETC_SHOWN = "BindReadOnlyPaths=-/etc/ld.so.cache -/etc/alternatives"


def etc_properties():
    view = setting("FILEDUDE_SANDBOX_ETC", "/opt/filesdude/sandbox-etc-view")
    if os.path.isdir(view):
        return ["BindReadOnlyPaths=" + quote(view) + ":/etc", ETC_SHOWN]
    # Installed by an older installer, which made no placeholders (an update makes them).
    return ["TemporaryFileSystem=/etc:ro", ETC_SHOWN]

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
    if not isinstance(seconds, (int, float)) or isinstance(seconds, bool) or not math.isfinite(seconds):
        seconds = DEFAULT_SECONDS
    seconds = min(max(1, round(seconds)), MAX_FILE_SECONDS if file_output is not None else MAX_SECONDS)
    inspect = request.get("inspectSockets") is True
    return {"tool": tool, "args": args, "seconds": seconds, "fileOutput": file_output, "inspectSockets": inspect}


def unit_arguments(request, unit):
    """systemd-run's arguments for one run of a checked request, as the unit with this name."""
    command, mounts = tool_command(request["tool"])
    seconds = request["seconds"]
    properties = SANDBOX + etc_properties()
    if request["inspectSockets"]:
        properties.append("SystemCallFilter=getsockname getsockopt")
    if request["fileOutput"] is not None:
        # The kernel refuses writes past the limit; reserving space and resizing aren't allowed at all.
        properties += ["LimitFSIZE=%d" % request["fileOutput"], "SystemCallFilter=~fallocate ftruncate"]
    # Runs stop when FilesDude stops or restarts (a new FilesDude wouldn't know about them).
    bound = os.environ.get("FILEDUDE_SANDBOX_BIND", "filesdude.service")
    if bound:
        properties.append("BindsTo=" + bound)
    # Stopping a run doesn't wait long for it.
    properties += ["RuntimeMaxSec=%d" % seconds, "TimeoutStopSec=5"]
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


def systemctl(*args):
    try:
        return subprocess.run([SYSTEMCTL, *args], capture_output=True, text=True, timeout=30, check=False).stdout
    except (subprocess.TimeoutExpired, OSError):
        return ""


def unit_gone(unit):
    state = systemctl("show", "-p", "LoadState", "-p", "ActiveState", unit)
    return "LoadState=not-found" in state or "ActiveState=inactive" in state or "ActiveState=failed" in state


def stop_unit(unit, process):
    """Stops a run for good: its unit may only be created after systemd-run is stopped, so the unit is
    stopped until it has stayed gone for a moment."""
    systemctl("stop", unit)
    process.kill()
    process.wait()
    gone_for = 0
    for _ in range(100):
        systemctl("stop", unit)
        gone_for = gone_for + 1 if unit_gone(unit) else 0
        if gone_for >= 3:
            return
        time.sleep(0.3)


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
        # The client sends nothing more, so anything readable means it has gone (or broke the protocol).
        if readable or time.monotonic() > deadline:
            stopped = True
            stop_unit(unit, process)
            break
    return 124 if stopped else process.returncode


# ---- Without systemd (Docker) ---------------------------------------------------------------------
#
# Each run is a process of its own (see contain), started here as root and then:
# - inside a root of its own (chroot): a folder in the image holding only the system's libraries,
#   ffmpeg, Node.js, and sharp, so FilesDude's state, the managed folder, /tmp, /proc, and /dev don't
#   exist for it, and nothing there is writable;
# - as a throwaway user and group, one of a range that no other run has while it runs, with no
#   supplementary groups and no capabilities (and no way back: no set-user-ID programs either);
# - with memory, task, open-file, CPU-time, and file-size limits;
# - under a system-call filter on top of Docker's own: no sockets at all (so no network, and no way to
#   reach FilesDude or this helper), no io_uring, namespaces, mounts, tracing, keyrings, shared
#   memory, or System V IPC, much like the systemd profile's; and no new processes, only threads, so
#   a run is one process, which this helper (as root, with CAP_KILL) kills when it's done or out of
#   time, without anything of the run being able to stop that.
# No process of a run's user is left before that ID is used again. The helper itself keeps only the
# capabilities this takes (switching users and groups, chroot, and killing), and only takes requests
# from FilesDude's account (and root).

HELPER = os.path.abspath(__file__)
PYTHON = "/usr/bin/python3"
CONTAINER_ROOT = "/opt/filesdude/sandbox"
# Each tool's program, inside that root.
CONTAINER_PROGRAMS = {"ffmpeg": "/usr/bin/ffmpeg", "ffprobe": "/usr/bin/ffprobe", "node": MOUNT_DIR + "/node"}
# The user and group IDs runs get: within the 65536 IDs that rootless Docker and userns-remap map, and
# clear of people's accounts, Debian's reserved IDs, and systemd's dynamic users.
CONTAINER_IDS = "59000-59999"
# Per run, like the systemd profile's MemoryMax and TasksMax.
CONTAINER_MEMORY = 512 * 1024 * 1024
CONTAINER_TASKS = 64
CONTAINER_OPEN_FILES = 256
# Starting a run (Python, and its filter), on top of its own time limit.
LAUNCH_SECONDS = 5
CAP_KILL, CAP_SETGID, CAP_SETUID, CAP_SYS_CHROOT = 5, 6, 7, 18
PR_SET_NO_NEW_PRIVS, PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL = 38, 47, 4

DENIED_CALLS = (
    # Sockets: no network, nothing on this machine. Reading and writing the standard input and output
    # handed over (which may be sockets) needs none of these.
    "socket socketpair connect bind listen accept accept4 getpeername setsockopt shutdown "
    "sendto sendmsg sendmmsg recvfrom recvmsg recvmmsg "
    # io_uring would do what the filter forbids (and is a common way to attack the kernel).
    "io_uring_setup io_uring_enter io_uring_register "
    # Namespaces, mounts, and roots.
    "unshare setns mount umount umount2 pivot_root chroot move_mount open_tree fsopen fsconfig fsmount fspick mount_setattr "
    # New processes (threads are clone with CLONE_THREAD, below), and other processes.
    "fork vfork ptrace process_vm_readv process_vm_writev kcmp pidfd_getfd perf_event_open "
    # Memory outside the memory limit, System V IPC, and POSIX message queues (the whole container
    # shares the last two).
    "memfd_create shmget shmat shmdt shmctl semget semop semtimedop semctl msgget msgsnd msgrcv msgctl "
    "mq_open mq_unlink mq_timedsend mq_timedreceive mq_notify mq_getsetattr "
    # Keyrings, BPF, userfaultfd, opening files by handle, and watching files.
    "keyctl add_key request_key bpf userfaultfd name_to_handle_at open_by_handle_at fanotify_init inotify_init inotify_init1 "
    # Running the system (refused anyway without capabilities).
    "init_module finit_module delete_module kexec_load kexec_file_load reboot swapon swapoff acct quotactl "
    "settimeofday clock_settime clock_adjtime adjtimex sethostname setdomainname syslog vhangup "
    "iopl ioperm modify_ldt uselib ustat sysfs _sysctl lookup_dcookie nfsservctl"
).split()
# The filter must have these, whatever else this system's libseccomp knows of.
ESSENTIAL_CALLS = {"socket", "socketpair", "connect", "io_uring_setup", "unshare", "setns", "mount", "chroot", "ptrace", "process_vm_readv", "bpf", "userfaultfd", "keyctl", "memfd_create"}
# clone's flags that make namespaces, and the one that makes a thread (rather than a process).
CLONE_NAMESPACES = (0x00020000, 0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000, 0x40000000)
CLONE_THREAD = 0x00010000
# mmap's flags for memory shared between processes, which the memory limit doesn't count.
MAP_SHARED_ANONYMOUS = 0x01 | 0x20
# What getsockopt tells of the other end of a socket (SO_PEERCRED, SO_PEERSEC, SO_PEERGROUPS,
# SO_PEERPIDFD): FilesDude's process, for the standard input and output.
PEER_OPTIONS = (17, 31, 59, 77)
# Faking terminal input (TIOCSTI), and the console's own requests (TIOCLINUX).
DENIED_IOCTLS = (0x5412, 0x541C)


def container_denied(run):
    """The system calls this run may not make."""
    denied = list(DENIED_CALLS)
    if not run["inspectSockets"]:
        denied += ["getsockname", "getsockopt"]
    if run["fileOutput"] is not None:
        # The kernel refuses writes past the limit; reserving space and resizing aren't allowed at all.
        denied += ["fallocate", "ftruncate", "truncate"]
    return denied


def container_limits(run):
    """The run's resource limits (soft and hard alike)."""
    return {
        "RLIMIT_DATA": CONTAINER_MEMORY,
        "RLIMIT_NPROC": CONTAINER_TASKS,
        "RLIMIT_NOFILE": CONTAINER_OPEN_FILES,
        # Two CPUs' worth over its time, like the systemd profile's CPUQuota=200%.
        "RLIMIT_CPU": 2 * run["seconds"] + LAUNCH_SECONDS,
        # Only a playable copy writes to a file (its output), and only up to its limit.
        "RLIMIT_FSIZE": run["fileOutput"] or 0,
        "RLIMIT_CORE": 0,
        "RLIMIT_MSGQUEUE": 0,
        "RLIMIT_RTPRIO": 0,
    }


def container_filter(run):
    """The run's system-call filter, to load once it has become the run's user."""
    import seccomp  # Debian's python3-seccomp (libseccomp), in the image

    rules = seccomp.SyscallFilter(defaction=seccomp.ALLOW)
    # Calls through another architecture's interface (32-bit x86) would get round the rules.
    rules.set_attr(seccomp.Attr.ACT_BADARCH, seccomp.KILL_PROCESS)
    refused = seccomp.ERRNO(errno.EPERM)
    added = set()
    for name in container_denied(run):
        try:
            rules.add_rule(refused, name)
            added.add(name)
        except ValueError:
            pass  # a call this libseccomp doesn't know of
    if not ESSENTIAL_CALLS <= added:
        raise RuntimeError("the system-call filter is missing " + " ".join(sorted(ESSENTIAL_CALLS - added)))
    for flag in CLONE_NAMESPACES:
        rules.add_rule(refused, "clone", seccomp.Arg(0, seccomp.MASKED_EQ, flag, flag))
    rules.add_rule(refused, "clone", seccomp.Arg(0, seccomp.MASKED_EQ, CLONE_THREAD, 0))
    # clone3's flags can't be checked (they're in memory), so it's missing: the C library uses clone.
    rules.add_rule(seccomp.ERRNO(errno.ENOSYS), "clone3")
    rules.add_rule(refused, "mmap", seccomp.Arg(3, seccomp.MASKED_EQ, MAP_SHARED_ANONYMOUS, MAP_SHARED_ANONYMOUS))
    if run["inspectSockets"]:
        for option in PEER_OPTIONS:
            rules.add_rule(refused, "getsockopt", seccomp.Arg(2, seccomp.EQ, option))
    for request in DENIED_IOCTLS:
        rules.add_rule(refused, "ioctl", seccomp.Arg(1, seccomp.MASKED_EQ, 0xFFFFFFFF, request))
    return rules


def become(number):
    """Becomes this user and group, with no other groups. Root's capabilities go, for good."""
    os.setgroups([])
    os.setresgid(number, number, number)
    os.setresuid(number, number, number)
    if os.getgroups() or os.getresuid() != (number,) * 3 or os.getresgid() != (number,) * 3:
        raise OSError("couldn't become the run's user")
    try:
        os.setuid(0)
    except PermissionError:
        return
    raise OSError("could become root again")


def contain(launch):
    """Becomes a run, then its tool. Started by container_run as root, with nothing open but the run's
    input, its output, and /dev/null."""
    import resource

    program = CONTAINER_PROGRAMS[launch["tool"]]
    # Made while the system's Python is still in reach.
    rules = container_filter(launch)
    # The kernel's out-of-memory killer takes a run before FilesDude.
    try:
        with open("/proc/self/oom_score_adj", "w") as score:
            score.write("1000")
    except OSError:
        pass
    for name, value in container_limits(launch).items():
        resource.setrlimit(getattr(resource, name), (value, value))
    # Long runs read whole videos; they yield the CPU (and the disk) to everything else.
    if launch["seconds"] > DEFAULT_SECONDS:
        os.nice(10)
    os.chroot(launch["root"])
    os.chdir("/")
    become(launch["id"])
    os.umask(0o077)
    os.closerange(3, 1 << 20)
    rules.load()
    os.execve(program, [program] + launch["args"], {})


def runs_as(pid, number):
    """Whether this process (not one that has ended) runs as this user."""
    try:
        with open("/proc/%d/status" % pid) as status:
            fields = dict(line.split(":", 1) for line in status if ":" in line)
    except OSError:
        return False  # gone already
    return str(number) in fields.get("Uid", "").split() and not fields.get("State", "").strip().startswith(("Z", "X"))


def processes_of(number):
    """The processes running as this user."""
    return [int(name) for name in os.listdir("/proc") if name.isdigit() and runs_as(int(name), number)]


def no_strays(number):
    """Kills anything still running as a run's user once the run has ended, and whether nothing is. A run
    can't start processes, so there shouldn't be any. Each is killed through a pidfd, checked after it's
    opened, so a process that ended and whose number was reused is never the one killed."""
    for _ in range(20):
        strays = processes_of(number)
        if not strays:
            return True
        for pid in strays:
            try:
                handle = os.pidfd_open(pid)
            except OSError:
                continue  # gone already
            try:
                if runs_as(pid, number):
                    signal.pidfd_send_signal(handle, signal.SIGKILL)
            except OSError:
                pass
            finally:
                os.close(handle)
        time.sleep(0.05)
    return False


class Ids:
    """The user and group IDs runs get: each run one of its own, never one with processes left."""

    def __init__(self, first, last, avoid):
        self.ids = [number for number in range(first, last + 1) if number not in avoid]
        self.busy = set()
        self.next = 0
        self.lock = threading.Lock()

    def take(self):
        with self.lock:
            for _ in range(len(self.ids)):
                candidate = self.ids[self.next]
                self.next = (self.next + 1) % len(self.ids)
                if candidate not in self.busy and not processes_of(candidate):
                    self.busy.add(candidate)
                    return candidate
        return None

    def give_back(self, number):
        with self.lock:
            self.busy.discard(number)


def usable(files, file_output):
    """Whether the handed files are what a run reads and writes: a file, pipe, or socket in, and a pipe
    or socket out (a file, for a playable copy). Never a folder or a device."""
    kinds = [stat.S_IFMT(os.fstat(descriptor).st_mode) for descriptor in files]
    outputs = (stat.S_IFREG,) if file_output is not None else (stat.S_IFIFO, stat.S_IFSOCK)
    return kinds[0] in (stat.S_IFREG, stat.S_IFIFO, stat.S_IFSOCK) and kinds[1] in outputs


def container_run(request, files, connection, ids, root):
    """Runs the request as a throwaway user in the sandbox's own root; the client leaving stops it."""
    try:
        if not usable(files, request["fileOutput"]):
            return 64
        number = ids.take()
        if number is None:
            return 75
        launch = dict(request, id=number, root=root)
        try:
            process = subprocess.Popen([PYTHON, "-I", HELPER, "--contain", json.dumps(launch)], stdin=files[0], stdout=files[1], stderr=subprocess.DEVNULL, close_fds=True, env={}, cwd="/")
        except OSError:
            ids.give_back(number)
            return 70
    finally:
        for descriptor in files:
            os.close(descriptor)
    deadline = time.monotonic() + request["seconds"] + LAUNCH_SECONDS
    stopped = False
    try:
        while process.poll() is None:
            readable, _, _ = select.select([connection], [], [], 0.5)
            # The client sends nothing more, so anything readable means it has gone (or broke the protocol).
            if readable or time.monotonic() > deadline:
                stopped = True
                break
    finally:
        # This helper started the run, so its process number stays the run's until it's collected here;
        # and with CAP_KILL, nothing the run does can keep it from being killed.
        if process.poll() is None:
            try:
                process.kill()
            except OSError:
                pass
        try:
            process.wait(timeout=30)
            cleared = no_strays(number)
        except subprocess.TimeoutExpired:
            stopped, cleared = True, False
        if cleared:
            ids.give_back(number)
        else:
            print("FilesDude's media sandbox couldn't stop the processes of user %d; that ID isn't used again" % number, file=sys.stderr)
    if stopped:
        return 124
    return process.returncode if process.returncode >= 0 else 128 - process.returncode


def capable(number):
    """Whether this process has this capability."""
    with open("/proc/self/status") as status:
        for line in status:
            if line.startswith("CapEff:"):
                return bool(int(line.split()[1], 16) >> number & 1)
    return False


class CapabilityHeader(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]


class CapabilityData(ctypes.Structure):
    _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32), ("inheritable", ctypes.c_uint32)]


def keep_only(capabilities):
    """Gives up every capability but these, and the gaining of any by running a program."""
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int] + [ctypes.c_ulong] * 4
    mask = sum(1 << number for number in capabilities)
    data = (CapabilityData * 2)(CapabilityData(mask, mask, 0), CapabilityData(0, 0, 0))
    if libc.capset(ctypes.byref(CapabilityHeader(0x20080522, 0)), data) != 0:
        raise OSError(ctypes.get_errno(), "capset")
    for option in ((PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL), (PR_SET_NO_NEW_PRIVS, 1)):
        if libc.prctl(*option, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "prctl")


def mapped(map_file, first, last):
    """Whether this user namespace map (/proc/self/uid_map) covers these IDs."""
    with open(map_file) as entries:
        for entry in entries:
            inside, _, count = (int(field) for field in entry.split())
            if inside <= first and last < inside + count:
                return True
    return False


def container_ids(client_uid, client_gid):
    """The IDs runs get (FILEDUDE_SANDBOX_IDS, FIRST-LAST), less any the container's accounts use."""
    text = setting("FILEDUDE_SANDBOX_IDS", CONTAINER_IDS)
    match = re.fullmatch(r"(\d{1,10})-(\d{1,10})", text)
    first, last = (int(match.group(1)), int(match.group(2))) if match else (0, -1)
    if not 0 < first <= last < 2 ** 32 - 2:
        raise ValueError("FILEDUDE_SANDBOX_IDS must be a range of user and group IDs, such as " + CONTAINER_IDS)
    if not (mapped("/proc/self/uid_map", first, last) and mapped("/proc/self/gid_map", first, last)):
        raise ValueError("the user and group IDs %s aren't in this container's user namespace: set FILEDUDE_SANDBOX_IDS to ones that are" % text)
    avoid = {client_uid, client_gid, 65534} | {entry.pw_uid for entry in pwd.getpwall()} | {entry.gr_gid for entry in grp.getgrall()}
    ids = Ids(first, min(last, first + 100_000), avoid)
    if len(ids.ids) < MAX_RUNNING:
        raise ValueError("FILEDUDE_SANDBOX_IDS has too few IDs")
    return ids


def check_container(root):
    """Raises the reason this container can't have the sandbox, if there is one."""
    if os.geteuid() != 0:
        raise RuntimeError("it must start as root")
    missing = [name for name, number in (("SETUID", CAP_SETUID), ("SETGID", CAP_SETGID), ("SYS_CHROOT", CAP_SYS_CHROOT), ("KILL", CAP_KILL)) if not capable(number)]
    if missing:
        raise RuntimeError("the container doesn't have the %s capability: add it to cap_add (see compose.yaml)" % " and ".join(missing))
    info = os.stat(root)
    if info.st_uid != 0 or info.st_mode & 0o022 or not stat.S_ISDIR(info.st_mode):
        raise RuntimeError(root + " must be a folder only root can change")
    for program in CONTAINER_PROGRAMS.values():
        if not os.path.isfile(os.path.join(root, program.lstrip("/"))):
            raise RuntimeError(program + " is missing from " + root)
    container_filter({"inspectSockets": True, "fileOutput": 1})


def listen_on(path, group):
    """Listens on a socket at this path that only root and this group can use, put there once ready."""
    staging = path + ".new"
    if os.path.lexists(staging):
        os.unlink(staging)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    previous = os.umask(0o177)
    try:
        server.bind(staging)
    finally:
        os.umask(previous)
    os.chown(staging, 0, group)
    os.chmod(staging, 0o660)
    server.listen(64)
    os.rename(staging, path)
    return server


def leave_with_parent():
    """Ends the helper when FilesDude does: it holds the other end of standard input."""
    try:
        while os.read(0, 65536):
            pass
    except OSError:
        pass
    os._exit(0)


def container_main(path, client_uid, client_gid):
    """Takes runs from FilesDude's account (and root) on a socket at this path until FilesDude stops."""
    root = os.path.realpath(setting("FILEDUDE_SANDBOX_ROOT", CONTAINER_ROOT))
    try:
        ids = container_ids(client_uid, client_gid)
        check_container(root)
        server = listen_on(path, client_gid)
        keep_only((CAP_SETUID, CAP_SETGID, CAP_SYS_CHROOT, CAP_KILL))
    except Exception as problem:  # noqa: BLE001 - whatever it is, FilesDude carries on without
        sys.exit("The media sandbox is off: %s." % problem)
    threading.Thread(target=leave_with_parent, daemon=True).start()
    accept_forever(server, {0, client_uid}, lambda request, files, connection: container_run(request, files, connection, ids, root))


def wait_for_slot(slots, connection):
    """Waits for a running slot, giving up when the client goes away or after a while."""
    deadline = time.monotonic() + SLOT_WAIT_SECONDS
    while time.monotonic() < deadline:
        if slots.acquire(timeout=0.5):
            return True
        readable, _, _ = select.select([connection], [], [], 0)
        if readable:
            return False
    return False


def serve(connection, allowed, slots, connections, runner):
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
        if not wait_for_slot(slots, connection):
            reply(connection, 75)
            return
        try:
            handed, files = files, []
            reply(connection, runner(request, handed, connection))
        finally:
            slots.release()
    except (ValueError, ConnectionError, OSError, OverflowError, json.JSONDecodeError):
        reply(connection, 64)
    except Exception:  # noqa: BLE001 - one bad request must never take the helper down
        reply(connection, 70)
    finally:
        for descriptor in files:
            try:
                os.close(descriptor)
            except OSError:
                pass
        connection.close()
        connections.release()


def allowed_accounts():
    """Root (tests) and FilesDude's own account may ask for runs."""
    allowed = {0}
    try:
        allowed.add(pwd.getpwnam(setting("FILEDUDE_SANDBOX_USER", "filesdude")).pw_uid)
    except KeyError:
        pass
    return allowed


def accept_forever(server, allowed, runner):
    slots = threading.BoundedSemaphore(MAX_RUNNING)
    connections = threading.BoundedSemaphore(MAX_CONNECTIONS)
    while True:
        try:
            connection, _ = server.accept()
        except OSError:
            time.sleep(0.1)
            continue
        if not connections.acquire(blocking=False):
            connection.close()
            continue
        try:
            threading.Thread(target=serve, args=(connection, allowed, slots, connections, runner), daemon=True).start()
        except RuntimeError:
            connection.close()
            connections.release()


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--print-args":
        print(json.dumps(unit_arguments(checked(json.loads(sys.argv[2])), "filesdude-media-example")))
        return
    if len(sys.argv) == 3 and sys.argv[1] == "--print-container":
        request = checked(json.loads(sys.argv[2]))
        print(json.dumps({"program": CONTAINER_PROGRAMS[request["tool"]], "args": request["args"], "limits": container_limits(request), "denied": container_denied(request)}))
        return
    if len(sys.argv) == 3 and sys.argv[1] == "--contain":
        contain(json.loads(sys.argv[2]))
        return
    if len(sys.argv) == 5 and sys.argv[1] == "--container":
        container_main(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
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
        sys.exit("usage: sandbox-helper.py --socket PATH | --print-args REQUEST | --container SOCKET UID GID | --print-container REQUEST (or socket activation)")
    accept_forever(server, allowed_accounts(), run)


if __name__ == "__main__":
    main()
