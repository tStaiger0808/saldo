#!/usr/bin/env bash
# Installs Saldo with Docker Compose on a Linux server in your home network.
# Generates all secrets locally into .env (mode 600, git-ignored). Safe to run again.
set -euo pipefail
umask 077

usage() {
  cat <<'USAGE'
Usage: ./install.sh [options]

  --bind <ip>        Address the app listens on (default: 127.0.0.1, for a reverse proxy on this host).
                     Another address serves plain HTTP straight to the network: it must be a private one
                     (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7), else --allow-public is required.
  --allow-public     Allow --bind with a public address or 0.0.0.0 (not recommended)
  --port <port>      Port the app listens on (default: 8000)
  --url <url>        Address you open Saldo at, e.g. https://192.168.1.10:8445 (default: http://<bind>:<port>)
  --demo             Load demo data after start (only works in an empty database)
  --no-start         Only create .env, do not build or start containers
  --install-docker   Install Docker via apt on Debian/Ubuntu if it is missing (uses sudo)
  -h, --help         Show this help

Environment:
  ADMIN_PASSWORD     Use this password for the first login instead of a generated one.

Saldo is meant for internal use (home network or VPN). Do not expose it to the internet.
USAGE
}

BIND=""
PORT=""
APP_URL=""
DEMO=0
START=1
INSTALL_DOCKER=0
ALLOW_PUBLIC=0

while [ $# -gt 0 ]; do
  case "$1" in
    --bind) BIND="${2:?--bind needs a value}"; shift 2 ;;
    --allow-public) ALLOW_PUBLIC=1; shift ;;
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --url) APP_URL="${2:?--url needs a value}"; shift 2 ;;
    --demo) DEMO=1; shift ;;
    --no-start) START=0; shift ;;
    --install-docker) INSTALL_DOCKER=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) printf 'error: unknown option: %s\n\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
done

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

cd "$(dirname "$0")"
[ -f compose.yml ] || die "compose.yml not found; run this script from the project root."
[ -f .env.example ] || die ".env.example not found."
command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets."

get_env() {
  grep -E "^$1=" .env | head -n 1 | cut -d= -f2- || true
}

set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  # Passed through the environment: command-line arguments are visible to every local user, and
  # awk -v would also mangle backslashes.
  SET_ENV_KEY="$key" SET_ENV_VALUE="$value" awk '
    BEGIN { FS = OFS = "="; k = ENVIRON["SET_ENV_KEY"]; v = ENVIRON["SET_ENV_VALUE"] }
    $1 == k && !done { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' .env >"$tmp"
  cat "$tmp" >.env
  rm -f "$tmp"
}

is_loopback() {
  case "$1" in
    127.* | ::1 | localhost) return 0 ;;
    *) return 1 ;;
  esac
}

# Private IPv4 ranges (RFC 1918), carrier-grade NAT / VPNs such as Tailscale (100.64/10) and IPv6 ULA (fc00::/7).
is_private() {
  local b
  case "$1" in
    10.* | 192.168.*) return 0 ;;
    172.*)
      b="$(printf '%s' "$1" | cut -d. -f2)"
      [ "$b" -ge 16 ] 2>/dev/null && [ "$b" -le 31 ] ;;
    100.*)
      b="$(printf '%s' "$1" | cut -d. -f2)"
      [ "$b" -ge 64 ] 2>/dev/null && [ "$b" -le 127 ] ;;
    [fF][cCdD]*:*) return 0 ;;
    *) return 1 ;;
  esac
}

secret() { openssl rand -base64 "$1" | tr -d '\n'; }
random_password() { openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-20; }

say "Saldo installer"
say "This app is for internal use only (home network or VPN). Do not expose it to the internet."
say

GENERATED_PASSWORD=""
if [ ! -f .env ]; then
  say "Creating .env with freshly generated secrets ..."
  cp .env.example .env
  chmod 600 .env
  set_env AUTH_SECRET "$(secret 48)"
  set_env ENCRYPTION_KEY "$(secret 32)"
  set_env POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  if [ -n "${ADMIN_PASSWORD:-}" ]; then
    set_env ADMIN_PASSWORD "$ADMIN_PASSWORD"
  else
    GENERATED_PASSWORD="$(random_password)"
    set_env ADMIN_PASSWORD "$GENERATED_PASSWORD"
  fi
  [ -n "$BIND" ] || BIND="127.0.0.1"
else
  say "Keeping existing .env (not overwritten)."
  chmod 600 .env
  [ -n "$(get_env AUTH_SECRET)" ] || die "AUTH_SECRET is empty in .env."
  [ -n "$(get_env ENCRYPTION_KEY)" ] || die "ENCRYPTION_KEY is empty in .env."
  [ -n "$(get_env POSTGRES_PASSWORD)" ] || die "POSTGRES_PASSWORD is empty in .env."
fi

mkdir -p backups
chmod 700 backups
[ -n "$(get_env BACKUP_UID)" ] || set_env BACKUP_UID "$(id -u)"
[ -n "$(get_env BACKUP_GID)" ] || set_env BACKUP_GID "$(id -g)"

BIND="${BIND:-$(get_env BIND_ADDRESS)}"
BIND="${BIND:-127.0.0.1}"
if ! is_loopback "$BIND"; then
  if ! is_private "$BIND" && [ "$ALLOW_PUBLIC" -ne 1 ]; then
    die "BIND_ADDRESS $BIND is not a private address; the app would answer anyone who reaches it over plain HTTP. Use 127.0.0.1 behind a reverse proxy, a private address, or --allow-public if you really mean it."
  fi
  warn "The app listens on $BIND: browsers on that network talk to it directly over plain HTTP, without the TLS, client-address and body-size handling of a reverse proxy. Keep TRUSTED_PROXY=off in .env then. Recommended: --bind 127.0.0.1 with HTTPS in front (README)."
fi

set_env BIND_ADDRESS "$BIND"
[ -z "$PORT" ] || set_env PORT "$PORT"
PORT="$(get_env PORT)"
PORT="${PORT:-8000}"

[ -z "$APP_URL" ] || set_env APP_URL "$APP_URL"
if [ -z "$(get_env APP_URL)" ]; then
  set_env APP_URL "http://${BIND}:${PORT}"
fi


if [ "$START" -eq 0 ]; then
  say ".env is ready (the first-login password is the ADMIN_PASSWORD value in it). Start later with: docker compose up -d --build"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  if [ "$INSTALL_DOCKER" -eq 1 ] && command -v apt-get >/dev/null 2>&1; then
    say "Installing Docker with apt (sudo required) ..."
    sudo apt-get update
    sudo apt-get install -y docker.io docker-compose-v2
  else
    die "Docker is not installed. On Ubuntu: sudo apt-get install -y docker.io docker-compose-v2 (or rerun with --install-docker)."
  fi
fi
docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is missing (package docker-compose-v2 on Ubuntu)."
docker info >/dev/null 2>&1 || die "Cannot talk to the Docker daemon. Is it running, and are you in the docker group (sudo usermod -aG docker \$USER, then log in again)?"

say "Building and starting containers (the first build takes a few minutes) ..."
docker compose up -d --build

say "Waiting for the app to become healthy ..."
healthy=0
for _ in $(seq 1 60); do
  if docker compose exec -T app bun -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1))" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done
[ "$healthy" -eq 1 ] || die "The app did not become healthy in time. Check: docker compose logs app"

if [ "$DEMO" -eq 1 ]; then
  say "Loading demo data ..."
  docker compose exec -T -w /app/apps/web app bun src/server/modules/seed/demo.ts || warn "Demo data was not loaded (the database is probably not empty)."
fi

say
say "Done. Open $(get_env APP_URL)"
say "Login:   $(get_env ADMIN_USERNAME)"
if [ -n "$GENERATED_PASSWORD" ]; then
  say "Password: ${GENERATED_PASSWORD}   (also stored in .env, shown only this once here)"
else
  say "Password: the ADMIN_PASSWORD value in .env"
fi
say
say "Next steps:"
say "  - Change the password in the app (Einstellungen, Passwort). ADMIN_PASSWORD in .env is only used on the first start."
say "  - Back up .env together with ./backups: without ENCRYPTION_KEY stored bank and AI keys cannot be decrypted."
say "  - Update later: git pull && docker compose up -d --build"
say "  - Logs: docker compose logs -f app"
