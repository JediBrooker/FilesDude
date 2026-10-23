#!/usr/bin/env bash
# Checks a FilesDude image the way the README sets it up: compose.yaml, `setup`, `up`, then signing in
# and working with files as PUID:PGID. Run from the repository: docker/smoke-test.sh IMAGE
set -Eeuo pipefail

IMAGE="${1:?Usage: docker/smoke-test.sh IMAGE}"
REPOSITORY="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
PASSWORD="smoke-test-password-$$"
URL="http://127.0.0.1:3000"
export COMPOSE_PROJECT_NAME="filesdude-smoke-$$" PUID="$(id -u)" PGID="$(id -g)"

fail() { printf 'Smoke test failed: %s\n' "$*" >&2; docker compose logs --no-color >&2 || true; exit 1; }
cleanup() { docker compose down --volumes --timeout 5 >/dev/null 2>&1 || true; rm -rf "${WORK}"; }

# The repository's compose file, using the image being checked.
sed "s|^    image: .*|    image: ${IMAGE}|" "${REPOSITORY}/compose.yaml" >"${WORK}/compose.yaml"
cd "${WORK}"
trap cleanup EXIT

# Before a login is set, FilesDude runs but says it isn't configured. ./files doesn't exist yet, so
# Docker makes it (as root), and FilesDude takes it over.
docker compose up -d --quiet-pull
for _ in $(seq 60); do curl -fsS "${URL}/api/auth/status" >status.json 2>/dev/null && break; sleep 1; done
grep -q '"configured":false' status.json || fail "expected an unconfigured server first: $(cat status.json 2>/dev/null)"
[[ $(docker compose logs --no-color) == *'has no login yet'* ]] || fail "no hint about setting the login"
[[ $(stat -c %u files) == "${PUID}" ]] || fail "the managed folder wasn't handed to PUID"

# Set the login without a terminal, then restart to use it.
docker compose run --rm -T -e FILEDUDE_INSTALL_PASSWORD="${PASSWORD}" filesdude setup --username smoke >/dev/null
docker compose up -d --force-recreate
for _ in $(seq 60); do curl -fsS "${URL}/api/auth/status" >status.json 2>/dev/null && break; sleep 1; done
grep -q '"configured":true' status.json || fail "not configured after setup: $(cat status.json)"

# FilesDude runs as PUID:PGID with no capabilities.
process_status() {
  docker compose exec -T filesdude node -e '
    const fs = require("fs");
    for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      if (new RegExp(process.argv[1]).test(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"))) {
        console.log(status.split("\n").filter((line) => /^(Uid|Gid|Groups|CapEff|CapPrm|CapAmb|CapInh|NoNewPrivs):/.test(line)).join(" "));
      }
    }' "$1"
}
PROCESS="$(process_status '^next-server')"
[[ ${PROCESS} =~ Uid:[[:space:]]+${PUID}[[:space:]] && ${PROCESS} =~ Gid:[[:space:]]+${PGID}[[:space:]] ]] || fail "not running as ${PUID}:${PGID}: ${PROCESS}"
for set in CapInh CapPrm CapEff CapAmb; do
  [[ ${PROCESS} =~ ${set}:[[:space:]]+0+($|[[:space:]]) ]] || fail "has capabilities: ${PROCESS}"
done
[[ ${PROCESS} =~ NoNewPrivs:[[:space:]]+1 ]] || fail "can gain privileges: ${PROCESS}"
# The media sandbox's helper stays root, with only KILL, SETGID, SETUID, and SYS_CHROOT.
HELPER="$(process_status 'sandbox-helper\.py.--container')"
[[ ${HELPER} =~ Uid:[[:space:]]+0[[:space:]] ]] || fail "no media sandbox helper: ${HELPER}"
for set in CapPrm CapEff; do
  [[ ${HELPER} =~ ${set}:[[:space:]]+0*400e0($|[[:space:]]) ]] || fail "the media sandbox helper has other capabilities: ${HELPER}"
done
[[ ${HELPER} =~ NoNewPrivs:[[:space:]]+1 ]] || fail "the media sandbox helper can gain privileges: ${HELPER}"
[[ $(docker compose logs --no-color) != *'media sandbox is off'* ]] || fail "the media sandbox is off"
# Nothing in the image can be run to become root again.
[[ -z $(docker compose exec -T filesdude find / -xdev -perm /6000 -type f) ]] || fail "the image has set-user-ID programs"
docker compose exec -T filesdude filesdude health || fail "the health check fails"

# Sign in, make a folder, and get a thumbnail of a picture put there from outside.
curl -fsS -c cookies -H 'Content-Type: application/json' -H 'X-FileDude-Request: 1' \
  -d "{\"username\":\"smoke\",\"password\":\"${PASSWORD}\"}" "${URL}/api/auth/login" >/dev/null || fail "couldn't sign in"
curl -fsS -b cookies -H 'Content-Type: application/json' -H 'X-FileDude-Request: 1' \
  -d '{"action":"create","path":"","name":"made-by-filesdude","type":"directory"}' "${URL}/api/fs" >/dev/null || fail "couldn't make a folder"
[[ $(stat -c %u:%g files/made-by-filesdude) == "${PUID}:${PGID}" ]] || fail "the new folder isn't owned by ${PUID}:${PGID}"
base64 -d >files/pixel.png <<<'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
curl -fsS -b cookies -o thumbnail "${URL}/api/fs/thumbnail?path=pixel.png" || fail "no thumbnail"
[[ $(head -c 4 thumbnail) == RIFF ]] || fail "the thumbnail isn't a WebP picture"

# A video gets a thumbnail (ffmpeg takes a frame, sharp resizes it), details (ffprobe), its subtitles
# (ffmpeg), and a copy that plays everywhere (ffmpeg, writing the file FilesDude opened), all in the
# media sandbox. The clip (H.264, AC-3 sound, and an SRT track) comes from the image's own ffmpeg, in
# the sandbox's root, where Matroska's random IDs need its /dev/urandom (see the Dockerfile).
printf '1\n00:00:00,500 --> 00:00:03,000\nHello from the sandbox\n' >subtitles.srt
docker run --rm -i --entrypoint /usr/sbin/chroot "${IMAGE}" /opt/filesdude/sandbox /usr/bin/ffmpeg -nostdin -loglevel error \
  -f lavfi -i testsrc=size=160x120:rate=10:duration=4 -f lavfi -i sine=duration=4 -f srt -i pipe:0 -map 0 -map 1 -map 2 \
  -c:v libx264 -preset ultrafast -c:a ac3 -c:s srt -f matroska - <subtitles.srt >files/clip.mkv 2>ffmpeg.log \
  || fail "couldn't make a video (exit $?): $(cat ffmpeg.log)"
curl -fsS -b cookies -o thumbnail "${URL}/api/fs/thumbnail?path=clip.mkv" || fail "no video thumbnail"
[[ $(head -c 4 thumbnail) == RIFF ]] || fail "the video thumbnail isn't a WebP picture"
curl -fsS -b cookies "${URL}/api/fs/media-info?path=clip.mkv" >details.json || fail "no video details"
grep -q '"width":160' details.json && grep -q '"height":120' details.json || fail "wrong video details: $(cat details.json)"
same_origin() { curl -fsS -b cookies -H 'Sec-Fetch-Site: same-origin' "$@"; }
same_origin "${URL}/api/fs/subtitles?path=clip.mkv" >tracks.json || fail "no subtitle tracks"
[[ $(cat tracks.json) =~ \"id\":\"([^\"]+)\" ]] || fail "no subtitle track found: $(cat tracks.json)"
[[ $(same_origin "${URL}/api/fs/subtitles?path=clip.mkv&track=${BASH_REMATCH[1]}") == *'Hello from the sandbox'* ]] || fail "the subtitles weren't extracted"
curl -sS -b cookies -H 'Content-Type: application/json' -H 'X-FileDude-Request: 1' -H "Origin: ${URL}" \
  -d '{"action":"prepare","path":"clip.mkv"}' "${URL}/api/fs/playback" >playback.json || fail "couldn't ask for a playable copy"
if grep -q PLAYBACK_NO_SPACE playback.json; then
  # Copies leave at least 10 GB of the disk free.
  echo "Skipped the playable copy: this machine's disk has less than its reserve free"
else
  grep -q '"state":"preparing"' playback.json || fail "couldn't start a playable copy: $(cat playback.json)"
  for _ in $(seq 60); do
    same_origin "${URL}/api/fs/playback?path=clip.mkv&status=1" >playback.json || fail "no playable copy status"
    grep -q '"state":"preparing"' playback.json || break
    sleep 1
  done
  grep -q '"state":"ready"' playback.json || fail "no playable copy: $(cat playback.json)"
  same_origin -o copy.mp4 "${URL}/api/fs/playback?path=clip.mkv" || fail "couldn't fetch the playable copy"
  [[ $(head -c 8 copy.mp4 | tail -c 4) == ftyp ]] || fail "the playable copy isn't an MP4"
fi

# A run is a throwaway user, without FilesDude's groups, that can't see FilesDude's state, the files,
# FilesDude's code, /proc, or any network, or write anywhere. Asked for the way FilesDude asks (as
# PUID, through the helper's client), it reports on itself.
read -r -d '' PROBE <<'EOF' || true
const fs = require("fs");
const tried = (action) => { try { action(); return "allowed"; } catch (error) { return error.code || String(error); } };
const report = {
  uid: process.getuid(), gid: process.getgid(), groups: process.getgroups().join(),
  state: tried(() => fs.readdirSync("/state")), login: tried(() => fs.readFileSync("/state/login.env")),
  files: tried(() => fs.readdirSync("/data")), app: tried(() => fs.readdirSync("/app")),
  proc: tried(() => fs.readFileSync("/proc/self/status")), write: tried(() => fs.writeFileSync("/tmp/written", "x")),
  process: require("child_process").spawnSync("/usr/local/bin/node", ["-e", "0"], { stdio: "inherit" }).error?.code ?? "allowed",
};
const done = (network) => { report.network = network; fs.writeSync(1, JSON.stringify(report)); process.exit(0); };
try {
  require("net").connect(3000, "127.0.0.1").on("connect", () => done("allowed")).on("error", (error) => done(error.code));
} catch (error) {
  done(error.code || String(error));
}
EOF
REPORT="$(docker compose exec -T --user "${PUID}:${PGID}" -e FILEDUDE_SANDBOX_SOCKET=/tmp/filesdude-sandbox/sandbox.sock filesdude python3 -I -c '
import json, os, sys
request = json.dumps({"tool": "node", "inspectSockets": True, "args": ["-e", sys.argv[1]]})
os.execv("/usr/bin/python3", ["python3", "-I", "/app/scripts/sandbox-client.py", request])' "${PROBE}" </dev/null)" \
  || fail "the media sandbox didn't run: ${REPORT}"
[[ ${REPORT} =~ \"uid\":([0-9]+),\"gid\":([0-9]+),\"groups\":\"([0-9]+)\" ]] || fail "no report from the media sandbox: ${REPORT}"
RUN_UID="${BASH_REMATCH[1]}"
[[ ${RUN_UID} != 0 && ${RUN_UID} != "${PUID}" && ${BASH_REMATCH[2]} == "${RUN_UID}" && ${BASH_REMATCH[3]} == "${RUN_UID}" ]] \
  || fail "the media sandbox runs as FilesDude, root, or with other groups: ${REPORT}"
for denied in state login files app proc write process network; do
  [[ ${REPORT} =~ \"${denied}\":\"(ENOENT|EACCES|EPERM|EROFS)\" ]] || fail "the media sandbox can reach ${denied}: ${REPORT}"
done
# The sandbox's root has nothing anyone else can write, and no programs with capabilities.
[[ -z $(docker run --rm --entrypoint find "${IMAGE}" /opt/filesdude/sandbox -xdev -perm -0002 ! -type l) ]] || fail "the media sandbox's root has writable paths"
CAPABLE="$(docker run --rm --entrypoint python3 "${IMAGE}" -I -c '
import os
for folder, _, names in os.walk("/"):
    if folder.startswith(("/proc", "/sys", "/dev")):
        continue
    for name in names:
        try:
            os.getxattr(os.path.join(folder, name), "security.capability", follow_symlinks=False)
            print(os.path.join(folder, name))
        except OSError:
            pass')"
[[ -z ${CAPABLE} ]] || fail "the image has programs with capabilities: ${CAPABLE}"

# A run's own system-call filter (with Docker's switched off) refuses sockets, new processes, shared
# memory, namespaces, io_uring, and tracing, but not threads.
FILTER="$(docker run --rm -i --security-opt seccomp=unconfined --entrypoint python3 "${IMAGE}" -I - <<'EOF'
import ctypes, errno, importlib.util, mmap, os, platform, socket, threading
spec = importlib.util.spec_from_file_location("helper", "/app/scripts/sandbox-helper.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
helper.container_filter({"inspectSockets": False, "fileOutput": None}).load()
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
def raw(number, *args):
    return 0 if libc.syscall(ctypes.c_long(number), *[ctypes.c_long(arg) for arg in args]) >= 0 else ctypes.get_errno()
def tried(action):
    try:
        action()
        return 0
    except OSError as error:
        return error.errno
ptrace = {"aarch64": 117, "x86_64": 101}[platform.machine()]
thread = threading.Thread(target=lambda: None)
results = {
    "socket": tried(lambda: socket.socket(socket.AF_INET)), "unix": tried(lambda: socket.socket(socket.AF_UNIX)),
    "fork": tried(os.fork), "memfd": tried(lambda: os.memfd_create("x")), "shared": tried(lambda: mmap.mmap(-1, 4096)),
    "unshare": tried(lambda: os.unshare(os.CLONE_NEWUSER)), "io_uring": raw(425, 1, 0), "ptrace": raw(ptrace, 0, 0, 0, 0),
}
thread.start()
thread.join()
print(" ".join("%s=%s" % (name, errno.errorcode.get(code, code)) for name, code in results.items()))
EOF
)" || fail "the system-call filter test didn't run: ${FILTER}"
for call in socket unix fork memfd shared unshare io_uring ptrace; do
  [[ ${FILTER} =~ (^|[[:space:]])${call}=EPERM($|[[:space:]]) ]] || fail "a run's filter allows ${call}: ${FILTER}"
done

# Its user has no processes left once it's done.
[[ -z $(docker compose exec -T filesdude sh -c "grep -l '^Uid:[[:space:]]*${RUN_UID}[[:space:]]' /proc/[0-9]*/status 2>/dev/null") ]] || fail "the media sandbox's user still has processes"

sign_in() {
  curl -fsS -c cookies -H 'Content-Type: application/json' -H 'X-FileDude-Request: 1' \
    -d "{\"username\":\"smoke\",\"password\":\"$1\"}" "${URL}/api/auth/login" >/dev/null 2>&1
}
wait_for_restart() {
  sleep 3
  for _ in $(seq 60); do curl -fsS "${URL}/api/auth/status" >/dev/null 2>&1 && return; sleep 1; done
  fail "FilesDude didn't come back"
}

# The login survives a restart (it's kept in the state volume).
docker compose restart >/dev/null
wait_for_restart
sign_in "${PASSWORD}" || fail "couldn't sign in after a restart"

# Replacing the login in the running container restarts FilesDude with it; the old one stops working.
# (The container stops under the command, which may end it early.)
docker compose exec -T -e FILEDUDE_INSTALL_PASSWORD="${PASSWORD}-new" filesdude filesdude setup --username smoke >/dev/null || true
wait_for_restart
sign_in "${PASSWORD}-new" || fail "couldn't sign in with the replaced login"
if sign_in "${PASSWORD}"; then fail "the old login still works"; fi

printf 'Smoke test passed: %s\n' "${IMAGE}"
