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
docker compose logs --no-color | grep -q 'has no login yet' || fail "no hint about setting the login"
[[ $(stat -c %u files) == "${PUID}" ]] || fail "the managed folder wasn't handed to PUID"

# Set the login without a terminal, then restart to use it.
docker compose run --rm -T -e FILEDUDE_INSTALL_PASSWORD="${PASSWORD}" filesdude setup --username smoke >/dev/null
docker compose up -d --force-recreate
for _ in $(seq 60); do curl -fsS "${URL}/api/auth/status" >status.json 2>/dev/null && break; sleep 1; done
grep -q '"configured":true' status.json || fail "not configured after setup: $(cat status.json)"

# FilesDude runs as PUID:PGID with no capabilities.
PROCESS="$(docker compose exec -T filesdude node -e '
  const fs = require("fs");
  for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    if (fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").startsWith("next-server")) {
      console.log(status.split("\n").filter((line) => /^(Uid|Gid|CapEff|CapPrm|CapAmb):/.test(line)).join(" "));
    }
  }')"
[[ ${PROCESS} =~ Uid:[[:space:]]+${PUID}[[:space:]] && ${PROCESS} =~ Gid:[[:space:]]+${PGID}[[:space:]] ]] || fail "not running as ${PUID}:${PGID}: ${PROCESS}"
[[ ${PROCESS} =~ CapEff:[[:space:]]+0+[[:space:]] && ${PROCESS} =~ CapPrm:[[:space:]]+0+[[:space:]] && ${PROCESS} =~ CapAmb:[[:space:]]+0+($|[[:space:]]) ]] || fail "has capabilities: ${PROCESS}"

# Sign in, make a folder, and get a thumbnail of a picture put there from outside.
curl -fsS -c cookies -H 'Content-Type: application/json' -H 'X-FileDude-Request: 1' \
  -d "{\"username\":\"smoke\",\"password\":\"${PASSWORD}\"}" "${URL}/api/auth/login" >/dev/null || fail "couldn't sign in"
curl -fsS -b cookies -H 'Content-Type: application/json' -H 'X-FileDude-Request: 1' \
  -d '{"action":"create","path":"","name":"made-by-filesdude","type":"directory"}' "${URL}/api/fs" >/dev/null || fail "couldn't make a folder"
[[ $(stat -c %u:%g files/made-by-filesdude) == "${PUID}:${PGID}" ]] || fail "the new folder isn't owned by ${PUID}:${PGID}"
base64 -d >files/pixel.png <<<'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
curl -fsS -b cookies -o thumbnail "${URL}/api/fs/thumbnail?path=pixel.png" || fail "no thumbnail"
[[ $(head -c 4 thumbnail) == RIFF ]] || fail "the thumbnail isn't a WebP picture"

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
