FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN groupadd --system --gid 1001 filesdude && useradd --system --uid 1001 --gid filesdude filesdude \
    && mkdir -p /state && chown filesdude:filesdude /state
COPY --from=builder --chown=filesdude:filesdude /app/.next/standalone ./
COPY --from=builder --chown=filesdude:filesdude /app/.next/static ./.next/static
COPY --from=builder --chown=filesdude:filesdude /app/public ./public
EXPOSE 3000

# UID/GID can be overridden in compose. Run as root only when arbitrary chown is required.
USER filesdude
CMD ["node", "server.js"]
