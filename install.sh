#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="https://github.com/JediBrooker/FilesDude.git"
APP_HOME="/opt/filesdude"
CONFIG_DIR="/etc/filesdude"
ENV_FILE="${CONFIG_DIR}/filesdude.env"
STATE_DIR="/var/lib/filesdude"
UNIT_FILE="/etc/systemd/system/filesdude.service"
BIND_ADDRESS="0.0.0.0"
PORT="3000"
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
  --bind ADDRESS          Listening address (default: 0.0.0.0)
  --port NUMBER           Listening port (default: 3000)
  --service-user USER     'filesdude' (safer) or 'root' (full chown access)
  --update                Update the application and keep all settings
  --reset-credentials     Replace the bootstrap login and clear saved credentials
  --help                  Show this help

For unattended first installs, set FILEDUDE_INSTALL_PASSWORD in the environment.
EOF
}

while (($#)); do
  case "$1" in
    --root) ROOT_PATH="${2:?Missing path}"; shift 2 ;;
    --username) INSTALL_USERNAME="${2:?Missing username}"; shift 2 ;;
    --bind) BIND_ADDRESS="${2:?Missing address}"; shift 2 ;;
    --port) PORT="${2:?Missing port}"; shift 2 ;;
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
say "Installing operating-system prerequisites"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git openssl xz-utils >/dev/null

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
git clone --depth 1 --branch main "${REPOSITORY}" "${BUILD_ROOT}/source" >/dev/null 2>&1
cd "${BUILD_ROOT}/source"
npm ci --no-audit --no-fund >/dev/null
NEXT_TELEMETRY_DISABLED=1 npm run build >/dev/null

RELEASE="${APP_HOME}/releases/$(date -u +%Y%m%d%H%M%S)"
mkdir -p "${RELEASE}/.next"
cp -a .next/standalone/. "${RELEASE}/"
cp -a .next/static "${RELEASE}/.next/static"
cp -a public "${RELEASE}/public"
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
  local username="$1" password="$2" root_path="$3" hash_line hash secret
  [[ ${username} =~ ^[A-Za-z0-9._-]{3,64}$ ]] || fail "Username must be 3–64 letters, numbers, dots, dashes, or underscores."
  hash_line="$(FILEDUDE_PASSWORD="${password}" node scripts/hash-password.mjs)"
  hash="${hash_line#FILEDUDE_PASSWORD_HASH=\'}"
  hash="${hash%\'}"
  secret="$(openssl rand -base64 48 | tr -d '\n')"
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
    printf 'FILEDUDE_TRUST_PROXY=false\n'
  } >"${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
}

if [[ ${MODE} == "update" ]]; then
  [[ -f ${ENV_FILE} ]] || fail "No existing FilesDude configuration was found. Run the normal installer first."
elif [[ ${MODE} == "reset" ]]; then
  [[ -f ${ENV_FILE} ]] || fail "No existing FilesDude configuration was found. Run the normal installer first."
  ROOT_PATH="$(sed -n 's/^FILEDUDE_ROOT=//p' "${ENV_FILE}" | head -n 1)"
  BIND_ADDRESS="$(sed -n 's/^HOSTNAME=//p' "${ENV_FILE}" | head -n 1)"
  PORT="$(sed -n 's/^PORT=//p' "${ENV_FILE}" | head -n 1)"
  EXISTING_USERNAME="$(sed -n 's/^FILEDUDE_USERNAME=//p' "${ENV_FILE}" | head -n 1)"
  INSTALL_USERNAME="${INSTALL_USERNAME:-$(prompt_value "Replacement username" "${EXISTING_USERNAME:-admin}")}"
  INSTALL_PASSWORD="$(prompt_password)"
  write_environment "${INSTALL_USERNAME}" "${INSTALL_PASSWORD}" "${ROOT_PATH}"
  rm -f "${STATE_DIR}/credentials.json"
else
  ROOT_PATH="${ROOT_PATH:-$(prompt_value "Folder FilesDude may manage" "/mnt/pve")}"
  [[ ${ROOT_PATH} == /* && ${ROOT_PATH} != "/" ]] || fail "The managed folder must be an absolute path and cannot be /."
  mkdir -p "${ROOT_PATH}"
  INSTALL_USERNAME="${INSTALL_USERNAME:-$(prompt_value "Initial username" "admin")}"
  INSTALL_PASSWORD="$(prompt_password)"
  write_environment "${INSTALL_USERNAME}" "${INSTALL_PASSWORD}" "${ROOT_PATH}"
fi

# Read the configured root without executing the environment file.
ROOT_PATH="$(sed -n 's/^FILEDUDE_ROOT=//p' "${ENV_FILE}" | head -n 1)"
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

[Install]
WantedBy=multi-user.target
EOF

cat >/usr/local/sbin/filesdude-update <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
tmp="$(mktemp)"
trap 'rm -f "${tmp}"' EXIT
curl -fsSL https://raw.githubusercontent.com/JediBrooker/FilesDude/main/install.sh -o "${tmp}"
bash "${tmp}" --update "$@"
EOF
chmod 755 /usr/local/sbin/filesdude-update

systemctl daemon-reload
systemctl enable --now filesdude.service >/dev/null
systemctl restart filesdude.service

# Keep the three newest immutable releases.
mapfile -t OLD_RELEASES < <(find "${APP_HOME}/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +4 | cut -d' ' -f2-)
if ((${#OLD_RELEASES[@]})); then rm -rf -- "${OLD_RELEASES[@]}"; fi

say "Installation complete"
printf 'Open: http://<proxmox-ip>:%s\n' "${PORT}"
printf 'Status: systemctl status filesdude\n'
printf 'Logs: journalctl -u filesdude -f\n'
printf 'Update later: sudo filesdude-update\n'
printf '\nFor remote access, place an HTTPS reverse proxy or VPN in front of FilesDude.\n'
