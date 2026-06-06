#!/usr/bin/env bash
# One-command setup for a fresh machine.
# Requires: Docker, Node 20+
set -euo pipefail

cd "$(dirname "$0")/.."

# ── pretty output ─────────────────────────────────────────────────────────────
BOLD=$(tput bold 2>/dev/null || echo "")
DIM=$(tput dim 2>/dev/null || echo "")
RESET=$(tput sgr0 2>/dev/null || echo "")
OK="${BOLD}✓${RESET}"
ARROW="${DIM}→${RESET}"

step() { echo ""; echo "${BOLD}${1}${RESET}"; }
info() { echo "  ${ARROW} $1"; }
ok()   { echo "  ${OK} $1"; }
die()  { echo ""; echo "  ✗ $1" >&2; exit 1; }

# ── 1. preflight ──────────────────────────────────────────────────────────────
step "1. Preflight checks"

command -v docker >/dev/null 2>&1 || die "Docker is not installed. Get it from https://docker.com"
docker info >/dev/null 2>&1 || die "Docker is installed but not running. Start Docker Desktop."
ok "Docker is running"

command -v node >/dev/null 2>&1 || die "Node.js is not installed. Get it from https://nodejs.org (v20+)"
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node v20+ required (you have v$NODE_MAJOR)"
ok "Node $(node -v)"

# ── 2. env file ───────────────────────────────────────────────────────────────
step "2. Environment"

if [[ ! -f .env.local ]]; then
  cp .env.example .env.local
  ok "Created .env.local from .env.example"

  echo ""
  echo "  ${BOLD}LiteLLM API key${RESET} (or leave blank to set later in .env.local)"
  echo "  ${DIM}This powers categorization, merchant normalization, and the agent chat.${RESET}"
  read -r -p "  LITELLM_API_KEY: " LITELLM_KEY < /dev/tty || LITELLM_KEY=""

  if [[ -n "$LITELLM_KEY" ]]; then
    # macOS-safe sed
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|^LITELLM_API_KEY=.*|LITELLM_API_KEY=$LITELLM_KEY|" .env.local
    else
      sed -i "s|^LITELLM_API_KEY=.*|LITELLM_API_KEY=$LITELLM_KEY|" .env.local
    fi
    ok "Saved LITELLM_API_KEY"
  else
    info "Skipped — edit .env.local later before running the app"
  fi
else
  ok ".env.local already exists"
fi

# ── 3. dependencies ───────────────────────────────────────────────────────────
step "3. Install dependencies"
info "Running npm install…"
npm install --silent
ok "Dependencies installed"

# ── 4. database ───────────────────────────────────────────────────────────────
step "4. Start Postgres"

docker compose up -d db
info "Waiting for Postgres to be ready…"

for i in {1..30}; do
  if docker compose exec -T db pg_isready -U finance >/dev/null 2>&1; then
    ok "Postgres is ready"
    break
  fi
  [[ "$i" -eq 30 ]] && die "Postgres did not become ready after 60s"
  sleep 2
done

# ── 5. schema ─────────────────────────────────────────────────────────────────
step "5. Apply schema"

# Check if schema already exists (idempotent)
EXISTING=$(docker compose exec -T db psql -U finance finance -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'transactions';" \
  2>/dev/null | tr -d '[:space:]' || echo "0")

if [[ "$EXISTING" == "1" ]]; then
  ok "Schema already exists — skipping"
else
  info "Applying migrations…"
  for migration in src/db/migrations/*.sql; do
    [[ -f "$migration" ]] || continue
    docker compose exec -T db psql -U finance finance < "$migration" > /dev/null
  done
  ok "Schema applied"
fi

# ── 6. seed ───────────────────────────────────────────────────────────────────
step "6. Seed starter categories"

EXISTING_CATS=$(docker compose exec -T db psql -U finance finance -tAc \
  "SELECT count(*) FROM categories;" 2>/dev/null | tr -d '[:space:]' || echo "0")

if [[ "$EXISTING_CATS" -gt "0" ]]; then
  ok "$EXISTING_CATS categories already exist — skipping seed"
else
  npm run db:seed --silent
  ok "Categories seeded"
fi

# ── done ──────────────────────────────────────────────────────────────────────
echo ""
echo "${BOLD}Setup complete.${RESET}"
echo ""
echo "  Start the app:  ${BOLD}npm run dev${RESET}"
echo "  Then open:      ${BOLD}http://localhost:3000${RESET}"
echo ""
