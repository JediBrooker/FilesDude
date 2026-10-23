FROM node:22-trixie-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund

FROM node:22-trixie-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# The commit shown in the sidebar (the build context has no .git to read it from).
ARG FILEDUDE_BUILD_COMMIT=""
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN FILEDUDE_BUILD_COMMIT="${FILEDUDE_BUILD_COMMIT}" npm run build
# sharp and the packages it needs (this platform's), for the media sandbox.
RUN node -e ' \
  const fs = require("fs"), path = require("path"); \
  const copied = new Set(); \
  const copy = (name) => { \
    const from = path.join("node_modules", name); \
    if (copied.has(name) || !fs.existsSync(from)) return; \
    copied.add(name); \
    fs.cpSync(from, path.join("/sandbox-modules", name), { recursive: true, verbatimSymlinks: true }); \
    const manifest = JSON.parse(fs.readFileSync(path.join(from, "package.json"), "utf8")); \
    Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).forEach(copy); \
  }; \
  copy("sharp"); \
  if (!copied.has("sharp")) process.exit(1);'

# The media sandbox's own root (see "Without systemd" in scripts/sandbox-helper.py): pictures and
# videos are decoded inside it, by a throwaway user who sees nothing else of the container. It holds
# the system's libraries, ffmpeg, Node.js (which FilesDude runs on too), and sharp. Nothing in it is
# writable or set-user-ID. Debian 13 (trixie) because FilesDude hands ffmpeg its input as an open file
# (the fd: protocol), which needs ffmpeg 6 or newer: Debian 12's is 5.1.
FROM debian:trixie-slim AS media-sandbox
# ffmpeg's libraries bring Mesa's graphics drivers (with LLVM and Z3), which they only load for GPU
# work: nearly 200 MB that's never used here, so they go (and ffmpeg is checked to still work).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && dpkg --purge --force-depends mesa-libgallium libllvm19 libz3-4 \
    && ffmpeg -nostdin -hide_banner -loglevel error -f lavfi -i testsrc=duration=1 -c:v mpeg4 -f matroska - | ffprobe -hide_banner -loglevel error -show_entries stream=codec_name - \
    && rm -rf /var/lib/apt/lists/* /var/cache/* /var/log/* /usr/share/doc /usr/share/man /usr/share/locale
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=builder /sandbox-modules /run/filesdude/node_modules
RUN ln -s ../../usr/local/bin/node /run/filesdude/node \
    && find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
    && find / -xdev -perm -0002 ! -type l -exec chmod o-w {} +

FROM debian:trixie-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    FILEDUDE_ROOT=/data \
    FILEDUDE_STATE_DIR=/state
# Python runs the media sandbox's helper (with libseccomp, for its system-call filter) and its client.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-seccomp \
    && rm -rf /var/lib/apt/lists/* /var/cache/* /var/log/*
COPY --from=media-sandbox / /opt/filesdude/sandbox/
# The sandbox's /dev is otherwise empty. FFmpeg seeds some things (Matroska's IDs, for one) from
# /dev/urandom, and without it reads the CPU's cycle counter, which most Arm servers forbid (it dies of
# SIGILL). So these are plain files of fixed bytes, read-only: nothing a run does needs real
# randomness, and getrandom() still works for anything that would.
RUN head -c 4096 /dev/urandom >/opt/filesdude/sandbox/dev/urandom \
    && cp /opt/filesdude/sandbox/dev/urandom /opt/filesdude/sandbox/dev/random \
    && chmod 0444 /opt/filesdude/sandbox/dev/urandom /opt/filesdude/sandbox/dev/random
# FilesDude runs on the sandbox's Node.js, so the image holds it once. It runs as PUID:PGID (its own
# account, 1001, unless set). No set-user-ID or set-group-ID programs (su, passwd, mount...) either,
# so nothing in the container can become root again, even where no-new-privileges isn't set.
RUN ln -s /opt/filesdude/sandbox/usr/local/bin/node /usr/local/bin/node \
    && find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
    && groupadd --system --gid 1001 filesdude \
    && useradd --system --uid 1001 --gid filesdude --no-create-home --shell /usr/sbin/nologin filesdude \
    && mkdir -p /data /state && chown filesdude:filesdude /data /state && chmod 0700 /state
# The app belongs to root: FilesDude can read it but never change it.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY docker/filesdude.mjs ./docker/filesdude.mjs
COPY scripts/sandbox-helper.py scripts/sandbox-client.py ./scripts/
RUN chmod 0755 docker/filesdude.mjs && chmod 0644 scripts/sandbox-helper.py scripts/sandbox-client.py \
    && ln -s /app/docker/filesdude.mjs /usr/local/bin/filesdude
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["node", "/app/docker/filesdude.mjs", "health"]

# Starts as root only to hand /state to PUID:PGID and start the media sandbox's helper, then runs
# FilesDude as that account with no capabilities (see docker/filesdude.mjs). `setup` sets the login.
ENTRYPOINT ["node", "/app/docker/filesdude.mjs"]
CMD ["start"]
