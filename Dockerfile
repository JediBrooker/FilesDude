FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# The commit shown in the sidebar (the build context has no .git to read it from).
ARG FILEDUDE_BUILD_COMMIT=""
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN FILEDUDE_BUILD_COMMIT="${FILEDUDE_BUILD_COMMIT}" npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    FILEDUDE_ROOT=/data \
    FILEDUDE_STATE_DIR=/state
# FilesDude runs as PUID:PGID (its own account, 1001, unless set). The base image's `node` account
# (1000) goes, so it doesn't name the files of whoever has that ID on the host.
# No set-user-ID or set-group-ID programs (su, passwd, mount...) either, so nothing in the container can
# become root again, even where no-new-privileges isn't set.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + \
    && userdel --remove node \
    && groupadd --system --gid 1001 filesdude \
    && useradd --system --uid 1001 --gid filesdude --no-create-home --shell /usr/sbin/nologin filesdude \
    && mkdir -p /data /state && chown filesdude:filesdude /data /state && chmod 0700 /state
# The app belongs to root: FilesDude can read it but never change it.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY docker/filesdude.mjs ./docker/filesdude.mjs
RUN chmod 0755 docker/filesdude.mjs && ln -s /app/docker/filesdude.mjs /usr/local/bin/filesdude
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD ["node", "/app/docker/filesdude.mjs", "health"]

# Starts as root only to hand /state to PUID:PGID, then runs FilesDude as that account with no
# capabilities (see docker/filesdude.mjs). `setup` sets the login.
ENTRYPOINT ["node", "/app/docker/filesdude.mjs"]
CMD ["start"]
