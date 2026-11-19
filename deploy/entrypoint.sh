#!/bin/sh
set -eu
cd /app/apps/web
bun src/server/db/migrate.ts
exec bun .output/server/index.mjs
