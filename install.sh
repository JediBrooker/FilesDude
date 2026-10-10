#!/usr/bin/env bash
set -Eeuo pipefail

GITHUB_REPOSITORY="${FILEDUDE_GITHUB_REPOSITORY:-JediBrooker/FilesDude}"
GITHUB_REF="${FILEDUDE_GITHUB_REF:-main}"
APP_HOME="/opt/filesdude"
CONFIG_DIR="/etc/filesdude"
ENV_FILE="${CONFIG_DIR}/filesdude.env"
STATE_DIR="/var/lib/filesdude"
UNIT_FILE="/etc/systemd/system/filesdude.service"
BIND_ADDRESS="127.0.0.1"
PORT="3000"
LISTEN_REQUESTED="false"
MODE="install"
ROOT_PATH=""
INSTALL_USERNAME=""
SERVICE_ACCOUNT=""

say() { printf '\n\033[1;36mFilesDude\033[0m  %s\n' "$*"; }
fail() { printf '\n\033[1;31mFilesDude error:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: sudo bash install.sh [options]

Options:
  --root PATH             Folder FilesDude may manage (default: /mnt/pve)
  --username NAME         Initial login username (default: admin)
  --bind ADDRESS          Listening address (default: 127.0.0.1)
  --port NUMBER           Listening port (default: 3000)
  --service-user USER     'filesdude' (safer) or 'root' (full chown access)
  --update                Update the application and keep all settings
  --reset-credentials     Replace the bootstrap login and clear saved credentials
  --help                  Show this help

For unattended first installs, set FILEDUDE_INSTALL_PASSWORD in the environment.
For a private GitHub repository, also pass a read-only GITHUB_TOKEN.
EOF
}

while (($#)); do
  case "$1" in
    --root) ROOT_PATH="${2:?Missing path}"; shift 2 ;;
    --username) INSTALL_USERNAME="${2:?Missing username}"; shift 2 ;;
    --bind) BIND_ADDRESS="${2:?Missing address}"; LISTEN_REQUESTED="true"; shift 2 ;;
    --port) PORT="${2:?Missing port}"; LISTEN_REQUESTED="true"; shift 2 ;;
    --service-user) SERVICE_ACCOUNT="${2:?Missing user}"; shift 2 ;;
    --update) MODE="update"; shift ;;
    --reset-credentials) MODE="reset"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

[[ ${EUID} -eq 0 ]] || fail "Run this installer with sudo."
[[ ${PORT} =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) || fail "Port must be between 1 and 65535."

export DEBIAN_FRONTEND=noninteractive
export npm_config_update_notifier=false
say "Installing operating-system prerequisites"
apt-get update -qq
apt-get install -y -qq ca-certificates curl openssl tar xz-utils >/dev/null

ensure_node() {
  local current_major="0"
  if command -v node >/dev/null 2>&1; then
    current_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf 0)"
  fi
  if ((current_major >= 22)); then
    local system_home
    system_home="$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")"
    ln -sfn "${system_home}" "${APP_HOME}/node"
    return
  fi

  say "Installing the current verified Node.js 22 runtime"
  local architecture node_arch sums filename expected archive runtime
  architecture="$(uname -m)"
  case "${architecture}" in
    x86_64) node_arch="x64" ;;
    aarch64|arm64) node_arch="arm64" ;;
    *) fail "Unsupported processor architecture: ${architecture}" ;;
  esac
  sums="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt)"
  filename="$(awk -v suffix="linux-${node_arch}.tar.xz" '$2 ~ suffix "$" {print $2; exit}' <<<"${sums}")"
  expected="$(awk -v target="${filename}" '$2 == target {print $1; exit}' <<<"${sums}")"
  [[ -n ${filename} && -n ${expected} ]] || fail "Could not locate a Node.js 22 download."
  archive="$(mktemp --suffix=.tar.xz)"
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/${filename}" -o "${archive}"
  printf '%s  %s\n' "${expected}" "${archive}" | sha256sum --check --status || fail "Node.js checksum verification failed."
  runtime="${APP_HOME}/runtimes/${filename%.tar.xz}"
  mkdir -p "${APP_HOME}/runtimes"
  rm -rf "${runtime}"
  tar -xJf "${archive}" -C "${APP_HOME}/runtimes"
  rm -f "${archive}"
  ln -sfn "${runtime}" "${APP_HOME}/node"
}

mkdir -p "${APP_HOME}/releases" "${CONFIG_DIR}"
ensure_node
export PATH="${APP_HOME}/node/bin:${PATH}"

say "Downloading and building FilesDude"
BUILD_ROOT="$(mktemp -d)"
trap 'rm -rf "${BUILD_ROOT}"' EXIT
ARCHIVE="${BUILD_ROOT}/source.tar.gz"
SOURCE_URL="https://api.github.com/repos/${GITHUB_REPOSITORY}/tarball/${GITHUB_REF}"
CURL_AUTH=()
if [[ -n ${GITHUB_TOKEN:-} ]]; then
  TOKEN_CONFIG="${BUILD_ROOT}/github-curl.conf"
  umask 077
  printf 'header = "Authorization: Bearer %s"\n' "${GITHUB_TOKEN}" >"${TOKEN_CONFIG}"
  CURL_AUTH=(--config "${TOKEN_CONFIG}")
fi
if ! curl -fsSL --retry 3 --header 'Accept: application/vnd.github+json' \
  "${CURL_AUTH[@]}" "${SOURCE_URL}" -o "${ARCHIVE}"; then
  fail "Could not download ${GITHUB_REPOSITORY}. If it is private, pass a read-only GITHUB_TOKEN."
fi
mkdir -p "${BUILD_ROOT}/source"
tar -xzf "${ARCHIVE}" --strip-components=1 -C "${BUILD_ROOT}/source"
# GitHub names the tarball's top folder <owner>-<repo>-<short commit>; the app shows that commit.
BUILD_COMMIT="$(tar -tzf "${ARCHIVE}" 2>/dev/null | awk -F/ 'NR == 1 { print $1 }' || true)"
BUILD_COMMIT="${BUILD_COMMIT##*-}"
[[ ${BUILD_COMMIT} =~ ^[0-9a-f]{7,40}$ ]] || BUILD_COMMIT=""
cd "${BUILD_ROOT}/source"
npm ci --no-audit --no-fund >/dev/null
FILEDUDE_BUILD_COMMIT="${BUILD_COMMIT}" NEXT_TELEMETRY_DISABLED=1 npm run build >/dev/null

RELEASE="${APP_HOME}/releases/$(date -u +%Y%m%d%H%M%S)"
mkdir -p "${RELEASE}/.next"
cp -a .next/standalone/. "${RELEASE}/"
# Images are decoded by Node.js and sharp in a sandbox, as a temporary user who must be able to read
# the packages (and nothing else of the release).
chmod -R a+rX "${RELEASE}/node_modules"
cp -a .next/static "${RELEASE}/.next/static"
cp -a public "${RELEASE}/public"
install -m 0755 install.sh "${RELEASE}/install.sh"
ln -sfn "${RELEASE}" "${APP_HOME}/current.new"
mv -Tf "${APP_HOME}/current.new" "${APP_HOME}/current"

prompt_value() {
  local prompt="$1" default="$2" value=""
  if [[ -r /dev/tty ]]; then
    IFS= read -r -p "${prompt} [${default}]: " value </dev/tty || true
  fi
  printf '%s' "${value:-${default}}"
}

prompt_password() {
  local first="${FILEDUDE_INSTALL_PASSWORD:-}" second=""
  if [[ -z ${first} ]]; then
    [[ -r /dev/tty ]] || fail "Set FILEDUDE_INSTALL_PASSWORD for a non-interactive install."
    IFS= read -r -s -p "Choose a FilesDude password (12+ characters): " first </dev/tty
    printf '\n' >/dev/tty
    IFS= read -r -s -p "Confirm the password: " second </dev/tty
    printf '\n' >/dev/tty
    [[ ${first} == "${second}" ]] || fail "Passwords do not match."
  fi
  ((${#first} >= 12)) || fail "Password must contain at least 12 characters."
  printf '%s' "${first}"
}

write_environment() {
  local username="$1" password="$2" root_path="$3" hash_line hash secret trust_proxy="false"
  [[ ${username} =~ ^[A-Za-z0-9._-]{3,64}$ ]] || fail "Username must be 3–64 letters, numbers, dots, dashes, or underscores."
  hash_line="$(FILEDUDE_PASSWORD="${password}" node scripts/hash-password.mjs)"
  hash="${hash_line#FILEDUDE_PASSWORD_HASH=\'}"
  hash="${hash%\'}"
  secret="$(openssl rand -base64 48 | tr -d '\n')"
  if [[ ${BIND_ADDRESS} == "127.0.0.1" || ${BIND_ADDRESS} == "::1" ]]; then
    trust_proxy="true"
  fi
  umask 077
  {
    printf 'NODE_ENV=production\n'
    printf 'HOSTNAME=%s\n' "${BIND_ADDRESS}"
    printf 'PORT=%s\n' "${PORT}"
    printf 'FILEDUDE_ROOT=%s\n' "${root_path}"
    printf 'FILEDUDE_STATE_DIR=%s\n' "${STATE_DIR}"
    printf 'FILEDUDE_USERNAME=%s\n' "${username}"
    printf 'FILEDUDE_PASSWORD_HASH=%s\n' "${hash}"
    printf 'FILEDUDE_SESSION_SECRET=%s\n' "${secret}"
    printf 'FILEDUDE_SESSION_HOURS=12\n'
    printf 'FILEDUDE_MAX_UPLOAD_MB=512\n'
    printf 'FILEDUDE_TRASH_ENABLED=true\n'
    printf 'FILEDUDE_TRUST_PROXY=%s\n' "${trust_proxy}"
  } >"${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
}

# Reads KEY=value from the existing environment file without executing it.
env_value() { sed -n "s/^$1=//p" "${ENV_FILE}" | head -n 1; }

# Updates and resets keep the configured listener; the server binds 0.0.0.0:3000 when unset.
load_listen_address() {
  if [[ ${LISTEN_REQUESTED} == "true" ]]; then
    printf '\nNote: --bind and --port only apply to new installs. Edit HOSTNAME and PORT in %s instead.\n' "${ENV_FILE}" >&2
  fi
  BIND_ADDRESS="$(env_value HOSTNAME)"
  BIND_ADDRESS="${BIND_ADDRESS:-0.0.0.0}"
  PORT="$(env_value PORT)"
  PORT="${PORT:-3000}"
}

if [[ ${MODE} == "update" ]]; then
  [[ -f ${ENV_FILE} ]] || fail "No existing FilesDude configuration was found. Run the normal installer first."
  load_listen_address
elif [[ ${MODE} == "reset" ]]; then
  [[ -f ${ENV_FILE} ]] || fail "No existing FilesDude configuration was found. Run the normal installer first."
  ROOT_PATH="$(env_value FILEDUDE_ROOT)"
  load_listen_address
  EXISTING_USERNAME="$(env_value FILEDUDE_USERNAME)"
  INSTALL_USERNAME="${INSTALL_USERNAME:-$(prompt_value "Replacement username" "${EXISTING_USERNAME:-admin}")}"
  INSTALL_PASSWORD="$(prompt_password)"
  write_environment "${INSTALL_USERNAME}" "${INSTALL_PASSWORD}" "${ROOT_PATH}"
  # Passkeys sign in without the password, so a reset for a lost or exposed login removes them too.
  rm -f "${STATE_DIR}/credentials.json" "${STATE_DIR}/passkeys.json"
else
  ROOT_PATH="${ROOT_PATH:-$(prompt_value "Folder FilesDude may manage" "/mnt/pve")}"
  [[ ${ROOT_PATH} == /* && ${ROOT_PATH} != "/" ]] || fail "The managed folder must be an absolute path and cannot be /."
  mkdir -p "${ROOT_PATH}"
  INSTALL_USERNAME="${INSTALL_USERNAME:-$(prompt_value "Initial username" "admin")}"
  INSTALL_PASSWORD="$(prompt_password)"
  write_environment "${INSTALL_USERNAME}" "${INSTALL_PASSWORD}" "${ROOT_PATH}"
fi

# Read the configured root without executing the environment file.
ROOT_PATH="$(env_value FILEDUDE_ROOT)"
[[ -n ${ROOT_PATH} && ${ROOT_PATH} != "/" ]] || fail "Invalid FILEDUDE_ROOT in ${ENV_FILE}."

if [[ -z ${SERVICE_ACCOUNT} ]]; then
  if [[ ${MODE} != "install" && -f ${UNIT_FILE} ]]; then
    SERVICE_ACCOUNT="$(sed -n 's/^User=//p' "${UNIT_FILE}" | head -n 1)"
  elif [[ -r /dev/tty ]]; then
    answer=""
    IFS= read -r -p "Enable full ownership/permission administration by running as root? [y/N]: " answer </dev/tty || true
    [[ ${answer} =~ ^[Yy]$ ]] && SERVICE_ACCOUNT="root" || SERVICE_ACCOUNT="filesdude"
  else
    SERVICE_ACCOUNT="filesdude"
  fi
fi
[[ ${SERVICE_ACCOUNT} == "root" || ${SERVICE_ACCOUNT} == "filesdude" ]] || fail "--service-user must be root or filesdude."

if [[ ${SERVICE_ACCOUNT} == "filesdude" ]]; then
  getent group filesdude >/dev/null 2>&1 || groupadd --system filesdude
  id filesdude >/dev/null 2>&1 || useradd --system --gid filesdude --home-dir "${STATE_DIR}" --shell /usr/sbin/nologin filesdude
  install -d -o filesdude -g filesdude -m 0700 "${STATE_DIR}"
  if ! runuser -u filesdude -- test -r "${ROOT_PATH}" || ! runuser -u filesdude -- test -w "${ROOT_PATH}"; then
    printf '\nWarning: the filesdude service account cannot currently read and write %s.\n' "${ROOT_PATH}" >&2
    printf 'Adjust that folder\x27s group/ACL permissions or reinstall with --service-user root.\n' >&2
  fi
else
  install -d -o root -g root -m 0700 "${STATE_DIR}"
fi

quote_unit() { local value="${1//\\/\\\\}"; value="${value//\"/\\\"}"; printf '"%s"' "${value}"; }
ROOT_UNIT="$(quote_unit "${ROOT_PATH}")"
STATE_UNIT="$(quote_unit "${STATE_DIR}")"

CAPABILITIES=""
if [[ ${SERVICE_ACCOUNT} == "root" ]]; then
  CAPABILITIES=$'CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_FOWNER CAP_FSETID\nAmbientCapabilities=CAP_CHOWN CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_FOWNER CAP_FSETID'
fi

# ZFS snapshots: when the service runs as root over a folder on ZFS, it gets /dev/zfs (bound into
# its otherwise private /dev) and only the ZFS permissions snapshots need on that one dataset,
# delegated with zfs allow, instead of the broad CAP_SYS_ADMIN capability.
ZFS_UNIT=""
if [[ ${SERVICE_ACCOUNT} == "root" && -c /dev/zfs ]] && command -v zfs >/dev/null 2>&1; then
  ZFS_DATASET="$(zfs list -H -o name "${ROOT_PATH}" 2>/dev/null | head -n 1 || true)"
  if [[ -n ${ZFS_DATASET} ]]; then
    say "Allowing ZFS snapshots of ${ZFS_DATASET}"
    zfs allow -u root snapshot,destroy,mount "${ZFS_DATASET}"
    ZFS_UNIT=$'BindPaths=/dev/zfs\nDeviceAllow=/dev/zfs rw'
  fi
fi

say "Installing the systemd service"
cat >"${UNIT_FILE}" <<EOF
[Unit]
Description=FilesDude secure web file manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_ACCOUNT}
Group=${SERVICE_ACCOUNT}
WorkingDirectory=${APP_HOME}/current
EnvironmentFile=${ENV_FILE}
ExecStart=${APP_HOME}/node/bin/node server.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=20
UMask=0027
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
ProtectProc=invisible
ProcSubset=pid
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=${ROOT_UNIT} ${STATE_UNIT}
${CAPABILITIES}
${ZFS_UNIT}

[Install]
WantedBy=multi-user.target
EOF

cat >/usr/local/sbin/filesdude-update <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
exec /opt/filesdude/current/install.sh --update "$@"
EOF
chmod 755 /usr/local/sbin/filesdude-update

systemctl daemon-reload
systemctl enable --now filesdude.service >/dev/null
systemctl restart filesdude.service

# Keep the three newest immutable releases.
mapfile -t OLD_RELEASES < <(find "${APP_HOME}/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +4 | cut -d' ' -f2-)
if ((${#OLD_RELEASES[@]})); then rm -rf -- "${OLD_RELEASES[@]}"; fi

say "Installation complete"
LISTEN_HOST="${BIND_ADDRESS}"
[[ ${LISTEN_HOST} == *:* ]] && LISTEN_HOST="[${LISTEN_HOST}]"
printf 'Listening on: http://%s:%s\n' "${LISTEN_HOST}" "${PORT}"
printf 'Status: systemctl status filesdude\n'
printf 'Logs: journalctl -u filesdude -f\n'
printf 'Update later: sudo filesdude-update\n'
if [[ -n ${GITHUB_TOKEN:-} ]]; then
  printf 'Private-repo update: sudo GITHUB_TOKEN="$(gh auth token)" filesdude-update\n'
fi
printf '\nFor remote access, place an HTTPS reverse proxy or VPN in front of FilesDude.\n'
