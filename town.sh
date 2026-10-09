#!/usr/bin/env bash
# Run your own Agent Town on this computer with Docker, and keep its data between restarts.
#
#   ./town.sh up        build (first time or after pulling new code) and start
#   ./town.sh stop      turn it off (data kept)
#   ./town.sh start     turn it back on
#   ./town.sh status    is it running, and where
#   ./town.sh logs      follow the app's log
#   ./town.sh backup    save the database to backups/agenttown-<date>.sql
#   ./town.sh restore <file>   load a backup (replaces what's there now)
#   ./town.sh destroy   delete everything, data included (asks first)
#
# Your secrets live in .env.local (git-ignored). Keep AGENTTOWN_SECRET_KEY: it encrypts the AI
# accounts and app sign-ins you save, so with a different key they can't be read.
set -euo pipefail
cd "$(dirname "$0")"
ENV=${AGENTTOWN_ENV_FILE:-.env.local}
export AGENTTOWN_ENV_FILE=$ENV
# shellcheck disable=SC1090
load() { [ -f "$ENV" ] && set -a && . "$ENV" && set +a; return 0; }
dc() { docker compose --env-file "$ENV" "$@"; }

make_env() {
  [ -f "$ENV" ] && return
  umask 077
  rand() { python3 -c "import secrets; print(secrets.token_urlsafe(${1:-32}))"; }
  {
    echo "# Your local Agent Town (made by ./town.sh). Never commit this file."
    echo "AGENTTOWN_SECRET_KEY=$(rand 48)"
    echo "AGENTTOWN_DB_PASSWORD=$(rand 24)"
    echo "AGENTTOWN_ALLOW_SUBSCRIPTION_TOKENS=true"
    echo "AGENTTOWN_PORT=${AGENTTOWN_PORT:-8000}"
    echo "# The address people open. Change it when you share through a tunnel (see README)."
    echo "AGENTTOWN_APP_URL=http://127.0.0.1:${AGENTTOWN_PORT:-8000}"
  } > "$ENV"
  # Reuse your Google sign-in keys from development, if you set them up (copied, never printed).
  if [ -f backend/.env ]; then grep -E '^AGENTTOWN_GOOGLE_CLIENT_(ID|SECRET)=' backend/.env >> "$ENV" || true; fi
  echo "Made $ENV with a new secret key. Back it up somewhere safe along with your backups."
}

url() { echo "http://127.0.0.1:${AGENTTOWN_PORT:-8000}"; }

lan() {
  local ip; ip=$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)
  [ -n "$ip" ] && echo "Friends on the same Wi-Fi: http://$ip:${AGENTTOWN_PORT:-8000}"
}

[ "${1:-}" = up ] && make_env
load
case "${1:-}" in
  up)
    dc up -d --build
    echo "Agent Town is running: $(url)"; lan || true ;;
  start)
    [ -f "$ENV" ] || { echo "Run ./town.sh up first."; exit 1; }
    dc start
    echo "Agent Town is running: $(url)"; lan || true ;;
  stop) dc stop; echo "Stopped. Your data is kept; ./town.sh start brings it back." ;;
  status) dc ps; lan || true ;;
  logs) dc logs -f app ;;
  backup)
    mkdir -p backups
    f="backups/agenttown-$(date +%Y%m%d-%H%M%S).sql"
    dc exec -T db pg_dump -U agenttown --clean --if-exists agenttown > "$f"
    echo "Saved $f" ;;
  restore)
    [ -f "${2:-}" ] || { echo "Usage: ./town.sh restore backups/<file>.sql"; exit 1; }
    dc exec -T db psql -q -U agenttown -d agenttown < "$2"
    dc restart app
    echo "Restored $2" ;;
  destroy)
    read -r -p "Delete your local town AND all its data? Type 'delete' to confirm: " ok
    [ "$ok" = delete ] && dc down -v && echo "Deleted. (.env.local and backups/ are still here.)" ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//' ;;
esac
