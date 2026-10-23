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
ROTATE_SECRET="false"
ALLOW_FROM=""
ALLOW_FROM_REQUESTED="false"
ALLOW_INTERFACES=""
ALLOW_INTERFACES_REQUESTED="false"

say() { printf '\n\033[1;36mFilesDude\033[0m  %s\n' "$*"; }
fail() { printf '\n\033[1;31mFilesDude error:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: sudo bash install.sh [options]

Options:
  --root PATH             Folder FilesDude may manage (default: /mnt/pve on Proxmox,
                          /srv/files elsewhere)
  --username NAME         Initial login username (default: admin)
  --bind ADDRESS          Listening address (default: 127.0.0.1)
  --port NUMBER           Listening port (default: 3000)
  --service-user USER     'filesdude' (default: its own account, with just the file capabilities
                          it needs) or 'root' (older installs); an update can switch between them
  --allow-from LIST       Only these addresses (comma-separated, e.g. your reverse proxy or
                          tunnel) may reach the port; 'any' removes the filter
  --allow-interfaces LIST Network interfaces that may also reach it (e.g. tailscale0)
  --update                Update the application and keep all settings
  --reset-credentials     Replace the bootstrap login, clear saved credentials and passkeys,
                          and sign everyone out (other settings are kept)
  --rotate-secret         With --reset-credentials, also replace the session secret (this
                          also ends every share link and saved server credential)
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
    --allow-from) ALLOW_FROM="${2:?Missing addresses}"; ALLOW_FROM_REQUESTED="true"; shift 2 ;;
    --allow-interfaces) ALLOW_INTERFACES="${2:?Missing interfaces}"; ALLOW_INTERFACES_REQUESTED="true"; shift 2 ;;
    --update) MODE="update"; shift ;;
    --reset-credentials) MODE="reset"; shift ;;
    --rotate-secret) ROTATE_SECRET="true"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

[[ ${EUID} -eq 0 ]] || fail "Run this installer with sudo."
[[ ${PORT} =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) || fail "Port must be between 1 and 65535."

# FilesDude runs as a systemd service, and decodes media in throwaway systemd units. Systems without
# systemd (Alpine, most NAS systems, macOS, Windows) can run the Docker image instead.
DOCKER_HINT="The Docker image runs elsewhere: see https://github.com/${GITHUB_REPOSITORY}#install-with-docker"
[[ -d /run/systemd/system ]] || fail "FilesDude needs Linux running systemd. ${DOCKER_HINT}"
SYSTEMD_VERSION="$(systemctl --version 2>/dev/null | awk 'NR == 1 { print $2 }')"
SYSTEMD_VERSION="${SYSTEMD_VERSION%%[!0-9]*}"
# The media sandbox's settings (PrivateIPC, for one) need systemd 248 or newer.
[[ -n ${SYSTEMD_VERSION} ]] && ((SYSTEMD_VERSION >= 248)) \
  || fail "FilesDude needs systemd 248 or newer, and this system has ${SYSTEMD_VERSION:-an unknown version}. ${DOCKER_HINT}"
case "$(uname -m)" in
  x86_64|aarch64) ;;
  *) fail "FilesDude runs on x86_64 and arm64 processors, not $(uname -m)." ;;
esac

export DEBIAN_FRONTEND=noninteractive
export npm_config_update_notifier=false

# The package manager, for installing what the installer needs and this system lacks.
PACKAGE_MANAGER=""
for candidate in apt-get dnf zypper pacman; do
  if command -v "${candidate}" >/dev/null 2>&1; then PACKAGE_MANAGER="${candidate}"; break; fi
done

# Whether this system has a tool (or, for ca-certificates, a certificate bundle).
have() {
  case "$1" in
    ca-certificates) [[ -s /etc/ssl/certs/ca-certificates.crt || -s /etc/pki/tls/certs/ca-bundle.crt || -s /etc/ssl/ca-bundle.pem || -s /etc/ssl/cert.pem ]] ;;
    *) command -v "$1" >/dev/null 2>&1 ;;
  esac
}

# The package a tool comes in, for this system's package manager.
package_for() {
  case "$1:${PACKAGE_MANAGER}" in
    xz:apt-get) printf 'xz-utils' ;;
    python3:pacman) printf 'python' ;;
    find:*) printf 'findutils' ;;
    useradd:apt-get) printf 'passwd' ;;
    useradd:dnf) printf 'shadow-utils' ;;
    useradd:*) printf 'shadow' ;;
    nft:*) printf 'nftables' ;;
    *) printf '%s' "$1" ;;
  esac
}

# Installs the packages for these tools, where this system lacks them (nothing already there is changed).
install_tools() {
  local tool packages=()
  for tool in "$@"; do
    have "${tool}" || packages+=("$(package_for "${tool}")")
  done
  ((${#packages[@]})) || return 0
  say "Installing ${packages[*]}"
  case "${PACKAGE_MANAGER}" in
    apt-get) apt-get update -qq && apt-get install -y -qq "${packages[@]}" >/dev/null ;;
    dnf) dnf install -y -q --setopt=install_weak_deps=False "${packages[@]}" >/dev/null ;;
    zypper) zypper --non-interactive --quiet install --no-recommends "${packages[@]}" >/dev/null ;;
    pacman) pacman -S --needed --noconfirm "${packages[@]}" >/dev/null ;;
    *) false ;;
  esac || fail "FilesDude needs ${packages[*]}, which couldn't be installed here. Install them, then run the installer again."
}

say "Checking operating-system prerequisites"
install_tools ca-certificates curl openssl tar xz python3 find useradd
# The media sandbox helper and its client pass open files over a socket, which needs Python 3.9.
/usr/bin/python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null \
  || fail "FilesDude needs Python 3.9 or newer as /usr/bin/python3. ${DOCKER_HINT}"

ensure_node() {
  local current_major="0" system_node=""
  if command -v node >/dev/null 2>&1; then
    current_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf 0)"
    system_node="$(readlink -f "$(command -v node)")"
  fi
  # The system's own Node.js is only used from /usr, which the service can see (not from a home folder
  # or /opt, which it can't).
  if ((current_major >= 22)) && [[ ${system_node} == /usr/* ]]; then
    ln -sfn "$(dirname "$(dirname "${system_node}")")" "${APP_HOME}/node"
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
  tar --no-same-owner -xJf "${archive}" -C "${APP_HOME}/runtimes"
  rm -f "${archive}"
  ln -sfn "${runtime}" "${APP_HOME}/node"
}

mkdir -p "${APP_HOME}/releases" "${CONFIG_DIR}"
ensure_node
export PATH="${APP_HOME}/node/bin:${PATH}"

say "Downloading and building FilesDude"
# Built on disk beside the releases: /tmp is often a small in-memory filesystem.
BUILD_ROOT="$(mktemp -d "${APP_HOME}/build.XXXXXX")"
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
# The token is only for the download: nothing run by the build (package install scripts, the build
# itself) gets to see it.
rm -f "${TOKEN_CONFIG:-}"
HAD_GITHUB_TOKEN="${GITHUB_TOKEN:+true}"
unset GITHUB_TOKEN
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
cp -a .next/static "${RELEASE}/.next/static"
cp -a public "${RELEASE}/public"
install -m 0755 install.sh "${RELEASE}/install.sh"
# The media sandbox helper (run as root) and the client FilesDude reaches it with.
install -d -m 0755 "${RELEASE}/scripts"
install -m 0644 scripts/sandbox-helper.py scripts/sandbox-client.py "${RELEASE}/scripts/"
# Releases belong to root: FilesDude's account (its group, set below) can read them but never change
# them. Images are decoded by Node.js and sharp in a sandbox, as a temporary user who must be able to
# read the packages (and nothing else of the release).
chmod -R u+rwX,go-w,o-rx "${RELEASE}"
chmod -R a+rX "${RELEASE}/node_modules"
chmod 0755 "${APP_HOME}" "${APP_HOME}/releases"
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

# Sets KEY=value in the environment file in place, keeping every other line (added if missing).
set_env_value() {
  local key="$1" value="$2" temporary
  temporary="$(mktemp "${ENV_FILE}.XXXXXX")"
  { grep -v "^${key}=" "${ENV_FILE}" || true; printf '%s=%s\n' "${key}" "${value}"; } >"${temporary}"
  chmod 600 "${temporary}"
  mv -f "${temporary}" "${ENV_FILE}"
}

# A credentials reset replaces only the login, and signs everyone out by moving the sessions on a
# generation; every other setting (trusted proxies, limits, the listener) is kept. The secret, which
# share links and saved server credentials depend on, is only replaced with --rotate-secret.
reset_environment() {
  local username="$1" password="$2" hash_line hash epoch
  [[ ${username} =~ ^[A-Za-z0-9._-]{3,64}$ ]] || fail "Username must be 3–64 letters, numbers, dots, dashes, or underscores."
  hash_line="$(FILEDUDE_PASSWORD="${password}" node scripts/hash-password.mjs)"
  hash="${hash_line#FILEDUDE_PASSWORD_HASH=\'}"
  hash="${hash%\'}"
  umask 077
  cp -p "${ENV_FILE}" "${ENV_FILE}.bak-$(date +%Y%m%d%H%M%S)"
  set_env_value FILEDUDE_USERNAME "${username}"
  set_env_value FILEDUDE_PASSWORD_HASH "${hash}"
  epoch="$(env_value FILEDUDE_SESSION_EPOCH)"
  [[ ${epoch} =~ ^[0-9]+$ ]] || epoch=0
  set_env_value FILEDUDE_SESSION_EPOCH "$((epoch + 1))"
  if [[ ${ROTATE_SECRET} == "true" ]]; then
    set_env_value FILEDUDE_SESSION_SECRET "$(openssl rand -base64 48 | tr -d '\n')"
    printf '\nThe session secret was replaced: every share link and saved server credential has stopped working.\n' >&2
  fi
}

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
  reset_environment "${INSTALL_USERNAME}" "${INSTALL_PASSWORD}"
  # Passkeys sign in without the password, so a reset for a lost or exposed login removes them too.
  rm -f "${STATE_DIR}/credentials.json" "${STATE_DIR}/passkeys.json"
else
  # Proxmox keeps its storage under /mnt/pve.
  DEFAULT_ROOT="/srv/files"
  [[ -d /etc/pve ]] && DEFAULT_ROOT="/mnt/pve"
  ROOT_PATH="${ROOT_PATH:-$(prompt_value "Folder FilesDude may manage" "${DEFAULT_ROOT}")}"
  [[ ${ROOT_PATH} == /* && ${ROOT_PATH} != "/" ]] || fail "The managed folder must be an absolute path and cannot be /."
  mkdir -p "${ROOT_PATH}"
  INSTALL_USERNAME="${INSTALL_USERNAME:-$(prompt_value "Initial username" "admin")}"
  INSTALL_PASSWORD="$(prompt_password)"
  write_environment "${INSTALL_USERNAME}" "${INSTALL_PASSWORD}" "${ROOT_PATH}"
fi

# Read the configured root without executing the environment file.
ROOT_PATH="$(env_value FILEDUDE_ROOT)"
[[ -n ${ROOT_PATH} && ${ROOT_PATH} != "/" ]] || fail "Invalid FILEDUDE_ROOT in ${ENV_FILE}."
case "${ROOT_PATH}" in *[[:cntrl:]]*) fail "The managed folder's path can't contain control characters." ;; esac

# FilesDude can read and write everything in its folder, so a folder holding the system, its own
# release or state, or root's files would let anyone who took over FilesDude take over the host.
ROOT_REAL="$(realpath -m "${ROOT_PATH}")"
for sensitive in /etc /usr /bin /sbin /lib /lib32 /lib64 /libx32 /boot /root /proc /sys /dev /run /var/spool "${APP_HOME}" "${STATE_DIR}" "${CONFIG_DIR}"; do
  sensitive_real="$(realpath -m "${sensitive}")"
  if [[ ${ROOT_REAL} == "${sensitive_real}" || ${ROOT_REAL} == "${sensitive_real}/"* || ${sensitive_real} == "${ROOT_REAL}/"* ]]; then
    fail "FilesDude can't manage ${ROOT_PATH}: it holds or is inside ${sensitive}. Choose a data folder."
  fi
done

if [[ -z ${SERVICE_ACCOUNT} ]]; then
  if [[ ${MODE} != "install" && -f ${UNIT_FILE} ]]; then
    SERVICE_ACCOUNT="$(sed -n 's/^User=//p' "${UNIT_FILE}" | head -n 1)"
  fi
  SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-filesdude}"
fi
[[ ${SERVICE_ACCOUNT} == "root" || ${SERVICE_ACCOUNT} == "filesdude" ]] || fail "--service-user must be root or filesdude."

if [[ ${SERVICE_ACCOUNT} == "filesdude" ]]; then
  getent group filesdude >/dev/null 2>&1 || groupadd --system filesdude
  id filesdude >/dev/null 2>&1 || useradd --system --gid filesdude --home-dir "${STATE_DIR}" --shell "$(command -v nologin || printf /usr/sbin/nologin)" filesdude
fi
SERVICE_GROUP="${SERVICE_ACCOUNT}"
install -d -m 0700 "${STATE_DIR}"
chgrp -R "${SERVICE_GROUP}" "${RELEASE}"
chmod -R g+rX "${RELEASE}"

# The account's capabilities: changing owners, and reading and writing files whatever their
# permissions (FilesDude keeps its own accounts to their folders). Root is held to the same.
CAPABILITY_LIST="CAP_CHOWN CAP_DAC_OVERRIDE CAP_DAC_READ_SEARCH CAP_FOWNER CAP_FSETID"

# Paths in unit files: quoted, with backslashes, quotes, and systemd's % specifiers escaped.
quote_unit() { local value="${1//\\/\\\\}"; value="${value//\"/\\\"}"; value="${value//%/%%}"; printf '"%s"' "${value}"; }

# ZFS snapshots: over a folder on ZFS, the service gets /dev/zfs (bound into its otherwise private
# /dev) and only the ZFS permissions snapshots need on that one dataset, delegated with zfs allow,
# instead of the broad CAP_SYS_ADMIN capability.
ZFS_UNIT=""
if [[ -c /dev/zfs ]] && command -v zfs >/dev/null 2>&1; then
  ZFS_DATASET="$(zfs list -H -o name "${ROOT_PATH}" 2>/dev/null | head -n 1 || true)"
  if [[ -n ${ZFS_DATASET} ]]; then
    say "Allowing ZFS snapshots of ${ZFS_DATASET}"
    zfs allow -u "${SERVICE_ACCOUNT}" snapshot,destroy,mount "${ZFS_DATASET}"
    ZFS_UNIT=$'BindPaths=/dev/zfs\nDeviceAllow=/dev/zfs rw'
    # Snapshots are read from the dataset's .zfs folder, which a folder below its mountpoint doesn't
    # include: it is shown too (read-only; FilesDude keeps to its folder inside each snapshot).
    ZFS_MOUNTPOINT="$(zfs get -H -o value mountpoint "${ZFS_DATASET}" 2>/dev/null || true)"
    if [[ ${ZFS_MOUNTPOINT} == /* && ${ZFS_MOUNTPOINT} != "${ROOT_REAL}" && -d ${ZFS_MOUNTPOINT}/.zfs/snapshot ]]; then
      ZFS_UNIT+=$'\n'"BindReadOnlyPaths=$(quote_unit "-${ZFS_MOUNTPOINT}/.zfs/snapshot")"
    fi
  fi
fi
ROOT_UNIT="$(quote_unit "${ROOT_PATH}")"
STATE_UNIT="$(quote_unit "${STATE_DIR}")"

# What FilesDude can see of the host: the system's programs and libraries, its own release, its
# folder, its state, and the few files in /etc it needs (accounts and groups, name resolution, time
# zone, certificates). Everything else is replaced with an empty folder or hidden: the rest of /etc
# (Proxmox's cluster configuration and keys, SSH host keys, password hashes, any other service's
# secrets), /var, other storage, kernel debugging, and the sockets in /run, which its capabilities
# would otherwise let it use.
top_of() { local rest="${1#/}"; printf '/%s' "${rest%%/*}"; }
HIDDEN="-/boot -/lost+found -/sys/kernel/debug -/sys/kernel/security -/sys/firmware"
EMPTIED="/etc:ro /run:ro /opt:ro /var:ro"
ETC_SHOWN=""
for file in passwd group hosts host.conf resolv.conf nsswitch.conf gai.conf services protocols localtime timezone ssl/certs ca-certificates ld.so.cache alternatives hostid zfs; do
  ETC_SHOWN+=" -/etc/${file}"
done
for entry in /*; do
  name="${entry#/}"
  [[ -d ${entry} && ! -L ${entry} ]] || continue
  case "${name}" in
    usr|bin|sbin|lib|lib32|lib64|libx32|etc|proc|sys|dev|run|tmp|var|opt|home|root|boot|lost+found) continue ;;
  esac
  if [[ ${entry} == "$(top_of "${ROOT_PATH}")" || ${entry} == "$(top_of "${STATE_DIR}")" ]]; then
    # The folder holding FilesDude's own is emptied, apart from it (unless it is FilesDude's folder).
    [[ ${entry} == "${ROOT_PATH}" || ${entry} == "${STATE_DIR}" ]] || EMPTIED+=" $(quote_unit "${entry}"):ro"
  else
    HIDDEN+=" $(quote_unit "-${entry}")"
  fi
done

# Who may reach FilesDude's port: with addresses (or interfaces) set, only those (and this host)
# can, so nobody else on the network signs in over plain HTTP. Kept in the environment file.
if [[ ${ALLOW_FROM_REQUESTED} == "true" ]]; then
  [[ ${ALLOW_FROM} == "any" ]] && ALLOW_FROM=""
  set_env_value FILEDUDE_ALLOW_FROM "${ALLOW_FROM}"
fi
if [[ ${ALLOW_INTERFACES_REQUESTED} == "true" ]]; then
  set_env_value FILEDUDE_ALLOW_INTERFACES "${ALLOW_INTERFACES}"
fi
ALLOW_FROM="$(env_value FILEDUDE_ALLOW_FROM)"
ALLOW_INTERFACES="$(env_value FILEDUDE_ALLOW_INTERFACES)"
# FilesDude doesn't start without its port filter, so a filter that fails leaves it closed, not open.
FIREWALL_DEPENDENCY=""
if [[ -n ${ALLOW_FROM} || -n ${ALLOW_INTERFACES} ]]; then
  FIREWALL_DEPENDENCY=$'Requires=filesdude-firewall.service\nAfter=filesdude-firewall.service'
fi

say "Installing the systemd services"
cat >"${UNIT_FILE}" <<EOF
[Unit]
Description=FilesDude secure web file manager
After=network-online.target filesdude-sandbox.socket
Wants=network-online.target filesdude-sandbox.socket
${FIREWALL_DEPENDENCY}

[Service]
Type=simple
User=${SERVICE_ACCOUNT}
Group=${SERVICE_GROUP}
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
ProtectHome=tmpfs
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
RestrictNamespaces=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=${CAPABILITY_LIST}
AmbientCapabilities=${CAPABILITY_LIST}
TemporaryFileSystem=${EMPTIED}
InaccessiblePaths=${HIDDEN}
BindReadOnlyPaths=${APP_HOME} -/run/filesdude-sandbox -/run/systemd/resolve${ETC_SHOWN}
BindPaths=${ROOT_UNIT} ${STATE_UNIT}
ReadWritePaths=${ROOT_UNIT} ${STATE_UNIT}
${ZFS_UNIT}

[Install]
WantedBy=multi-user.target
EOF

# The media sandbox helper: the one part of FilesDude that runs as root, reached only through this
# socket, which only FilesDude's account can use. It starts ffmpeg, ffprobe, and the image decoder in
# throwaway sandboxed units (see scripts/sandbox-helper.py), and nothing else.
cat >/etc/systemd/system/filesdude-sandbox.socket <<EOF
[Unit]
Description=FilesDude media sandbox helper socket

[Socket]
ListenStream=/run/filesdude-sandbox/sandbox.sock
SocketUser=root
SocketGroup=${SERVICE_GROUP}
SocketMode=0660
DirectoryMode=0755

[Install]
WantedBy=sockets.target
EOF

# Only what the helper needs from the configuration (never the secrets).
helper_setting() {
  local value
  value="$(env_value "$1")"
  [[ -n ${value} ]] && printf 'Environment=%s\n' "$(quote_unit "$1=${value}")"
  return 0
}
cat >/etc/systemd/system/filesdude-sandbox.service <<EOF
[Unit]
Description=FilesDude media sandbox helper
Requires=filesdude-sandbox.socket
After=filesdude-sandbox.socket

[Service]
Type=simple
ExecStart=/usr/bin/python3 -I ${APP_HOME}/current/scripts/sandbox-helper.py
Environment=$(quote_unit "FILEDUDE_ROOT=${ROOT_PATH}")
Environment=$(quote_unit "FILEDUDE_STATE_DIR=${STATE_DIR}")
Environment=FILEDUDE_SANDBOX_USER=${SERVICE_ACCOUNT}
Environment=FILEDUDE_SANDBOX_NODE=${APP_HOME}/node/bin/node
Environment=FILEDUDE_SANDBOX_MODULES=${APP_HOME}/current/node_modules
$(helper_setting FILEDUDE_FFMPEG_PATH)
$(helper_setting FILEDUDE_FFPROBE_PATH)
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
PrivateNetwork=true
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictAddressFamilies=AF_UNIX
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
CapabilityBoundingSet=
MemoryMax=256M
TasksMax=128
EOF

# Every media sandbox run (ffmpeg, ffprobe, image decoding) goes in this slice, so together they can
# never take more than this of the host, however many are running.
cat >/etc/systemd/system/filesdude-media.slice <<'EOF'
[Unit]
Description=FilesDude media sandbox runs

[Slice]
MemoryMax=2G
MemorySwapMax=0
CPUQuota=400%
TasksMax=256
EOF

cat >/usr/local/sbin/filesdude-update <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
exec /opt/filesdude/current/install.sh --update "$@"
EOF
chmod 755 /usr/local/sbin/filesdude-update

FIREWALL_FILE="${CONFIG_DIR}/firewall.nft"
FIREWALL_UNIT="/etc/systemd/system/filesdude-firewall.service"
if [[ -n ${ALLOW_FROM} || -n ${ALLOW_INTERFACES} ]]; then
  install_tools nft
  NFT="$(command -v nft)"
  IPV4="" IPV6="" INTERFACES=""
  IFS=',' read -r -a entries <<<"${ALLOW_FROM}"
  for address in "${entries[@]}"; do
    address="${address// /}"
    [[ -z ${address} ]] && continue
    if [[ ${address} =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$ ]]; then IPV4+="${IPV4:+, }${address}"
    elif [[ ${address} =~ ^[0-9A-Fa-f:]+(/[0-9]{1,3})?$ && ${address} == *:* ]]; then IPV6+="${IPV6:+, }${address}"
    else fail "--allow-from: '${address}' isn't an IP address or network."
    fi
  done
  IFS=',' read -r -a entries <<<"${ALLOW_INTERFACES}"
  for interface in "${entries[@]}"; do
    interface="${interface// /}"
    [[ -z ${interface} ]] && continue
    [[ ${interface} =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || fail "--allow-interfaces: '${interface}' isn't an interface name."
    INTERFACES+="    tcp dport ${PORT} iifname \"${interface}\" accept"$'\n'
  done
  {
    printf '#!%s -f\n' "${NFT}"
    printf '# FilesDude: only these may reach port %s. Written by the FilesDude installer (see --allow-from).\n' "${PORT}"
    printf 'table inet filesdude\ndelete table inet filesdude\ntable inet filesdude {\n  chain input {\n'
    printf '    type filter hook input priority -10; policy accept;\n'
    printf '    tcp dport %s iifname "lo" accept\n' "${PORT}"
    [[ -n ${IPV4} ]] && printf '    tcp dport %s ip saddr { %s } accept\n' "${PORT}" "${IPV4}"
    [[ -n ${IPV6} ]] && printf '    tcp dport %s ip6 saddr { %s } accept\n' "${PORT}" "${IPV6}"
    printf '%s' "${INTERFACES}"
    printf '    tcp dport %s counter reject with tcp reset\n  }\n}\n' "${PORT}"
  } >"${FIREWALL_FILE}"
  nft -c -f "${FIREWALL_FILE}" || fail "The port filter in ${FIREWALL_FILE} isn't valid."
  cat >"${FIREWALL_UNIT}" <<EOF
[Unit]
Description=FilesDude port filter (only the allowed addresses reach FilesDude)
Before=filesdude.service
After=network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${NFT} -f ${FIREWALL_FILE}
ExecStop=${NFT} delete table inet filesdude

[Install]
WantedBy=multi-user.target
EOF
elif [[ ${ALLOW_FROM_REQUESTED} == "true" && -f ${FIREWALL_UNIT} ]]; then
  # Only removed when asked to (--allow-from any), never because the setting is missing.
  systemctl disable --now filesdude-firewall.service >/dev/null 2>&1 || true
  rm -f "${FIREWALL_UNIT}" "${FIREWALL_FILE}"
fi

systemctl daemon-reload
if [[ -f ${FIREWALL_UNIT} ]]; then
  systemctl enable filesdude-firewall.service >/dev/null
  systemctl restart filesdude-firewall.service
fi

# FilesDude's own files belong to its account: its state, and, when switching between root and its
# own account, its folders in the managed folder. Only folders the previous account owned that nobody
# else can write to are handed over (other users may write to the managed folder); the trash's items
# keep their owners.
systemctl stop filesdude.service filesdude-sandbox.service 2>/dev/null || true
find "${STATE_DIR}" -xdev ! -user "${SERVICE_ACCOUNT}" -exec chown -h "${SERVICE_ACCOUNT}:${SERVICE_GROUP}" {} +
PREVIOUS_ACCOUNT="filesdude"
[[ ${SERVICE_ACCOUNT} == "filesdude" ]] && PREVIOUS_ACCOUNT="root"
if id "${PREVIOUS_ACCOUNT}" >/dev/null 2>&1; then
  for internal in "${ROOT_PATH}/.filedude" "${ROOT_PATH}/.filedude/trash" "${ROOT_PATH}/.filedude/trash-info"; do
    if [[ -n $(find "${internal}" -maxdepth 0 -type d -user "${PREVIOUS_ACCOUNT}" ! -perm /022 2>/dev/null) ]]; then
      chown -h "${SERVICE_ACCOUNT}:${SERVICE_GROUP}" "${internal}"
    fi
  done
  INFO="${ROOT_PATH}/.filedude/trash-info"
  if [[ -n $(find "${INFO}" -maxdepth 0 -type d -user "${SERVICE_ACCOUNT}" ! -perm /022 2>/dev/null) ]]; then
    find "${INFO}" -mindepth 1 -maxdepth 1 -type f -user "${PREVIOUS_ACCOUNT}" -exec chown -h "${SERVICE_ACCOUNT}:${SERVICE_GROUP}" {} +
  fi
fi

systemctl enable --now filesdude-sandbox.socket >/dev/null
systemctl restart filesdude-sandbox.socket
systemctl enable filesdude.service >/dev/null
systemctl restart filesdude.service

# Keep the three newest immutable releases.
mapfile -t OLD_RELEASES < <(find "${APP_HOME}/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | tail -n +4 | cut -d' ' -f2-)
if ((${#OLD_RELEASES[@]})); then rm -rf -- "${OLD_RELEASES[@]}"; fi

# sudo on some systems (RHEL and its relatives) doesn't look in /usr/local/sbin.
UPDATE_COMMAND="filesdude-update"
if command -v sudo >/dev/null 2>&1 && sudo -V 2>/dev/null | grep -i "override user's \$PATH with" | grep -qv /usr/local/sbin; then
  UPDATE_COMMAND="/usr/local/sbin/filesdude-update"
fi

say "Installation complete"
LISTEN_HOST="${BIND_ADDRESS}"
[[ ${LISTEN_HOST} == *:* ]] && LISTEN_HOST="[${LISTEN_HOST}]"
printf 'Listening on: http://%s:%s\n' "${LISTEN_HOST}" "${PORT}"
printf 'Status: systemctl status filesdude\n'
printf 'Logs: journalctl -u filesdude -f\n'
printf 'Update later: sudo %s\n' "${UPDATE_COMMAND}"
if [[ -n ${HAD_GITHUB_TOKEN:-} ]]; then
  printf 'Private-repo update: sudo GITHUB_TOKEN="$(gh auth token)" %s\n' "${UPDATE_COMMAND}"
fi
# Listening beyond this host: the system's own firewall may still keep everyone else out.
if [[ ${BIND_ADDRESS} != "127.0.0.1" && ${BIND_ADDRESS} != "::1" ]]; then
  if systemctl is-active --quiet firewalld 2>/dev/null; then
    printf '\nfirewalld is running: to let other machines reach FilesDude, open its port with\n'
    printf '  sudo firewall-cmd --permanent --add-port=%s/tcp && sudo firewall-cmd --reload\n' "${PORT}"
  elif command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    printf '\nufw is active: to let other machines reach FilesDude, open its port with: sudo ufw allow %s/tcp\n' "${PORT}"
  fi
fi
if [[ ${SERVICE_ACCOUNT} == "root" ]]; then
  printf '\nFilesDude runs as root. To run it as its own account instead: sudo filesdude-update --service-user filesdude\n'
fi
if [[ -z ${ALLOW_FROM} && -z ${ALLOW_INTERFACES} ]]; then
  printf '\nFor remote access, place an HTTPS reverse proxy or VPN in front of FilesDude, and limit the\n'
  printf 'port to it with: sudo filesdude-update --allow-from ADDRESS\n'
else
  printf 'Port %s is reachable only from: %s\n' "${PORT}" "${ALLOW_FROM:-}${ALLOW_FROM:+${ALLOW_INTERFACES:+, }}${ALLOW_INTERFACES:+${ALLOW_INTERFACES}}"
fi
