# syntax=docker/dockerfile:1
FROM docker.io/oven/bun:1.4.4-slim AS build
WORKDIR /src
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/banking/package.json packages/banking/
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build \
  && rm -rf node_modules apps/web/node_modules packages/*/node_modules \
  && bun install --frozen-lockfile --production

# rclone for the backup targets: one pinned release, checked against the SHA-256 from that release's signed SHA256SUMS.
FROM docker.io/oven/bun:1.4.4-slim AS rclone
ARG TARGETARCH
ARG RCLONE_VERSION=1.75.2
ARG RCLONE_SHA256_AMD64=349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702
ARG RCLONE_SHA256_ARM64=7e1e8d69654941b7b7df84ee74c5f7fb09cce7d5496947fb7bf16b55ff427d10
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
  arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
  case "$arch" in \
    amd64) sum="$RCLONE_SHA256_AMD64" ;; \
    arm64) sum="$RCLONE_SHA256_ARM64" ;; \
    *) echo "No pinned rclone checksum for $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSLo /tmp/rclone.zip "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${arch}.zip"; \
  echo "${sum}  /tmp/rclone.zip" | sha256sum -c -; \
  unzip -q /tmp/rclone.zip -d /tmp; \
  install -m 0755 "/tmp/rclone-v${RCLONE_VERSION}-linux-${arch}/rclone" /usr/local/bin/rclone

FROM docker.io/oven/bun:1.4.4-slim
ARG GIT_SHA=""
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 BACKUP_DIR=/backups SALDO_GIT_SHA=${GIT_SHA}
# pg_dump and pg_restore of the same major version as the database (PostgreSQL 17, Debian's own package).
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-17 \
  && rm -rf /var/lib/apt/lists/* \
  && install -d -m 0700 -o bun -g bun /backups
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
WORKDIR /app
COPY --from=build --chown=root:root /src /app
COPY --chown=root:root deploy/entrypoint.sh /usr/local/bin/saldo-entrypoint
RUN chmod 0755 /usr/local/bin/saldo-entrypoint
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/saldo-entrypoint"]
