#!/usr/bin/env bash
# Export a full database dump using pg_dump from inside the Docker container.
# No local pg_dump required.
set -euo pipefail

cd "$(dirname "$0")/.."

OUTFILE="${1:-finance-$(date +%Y-%m-%d).dump}"

if ! docker compose ps db --status running 2>/dev/null | grep -q db; then
  echo "Postgres container is not running. Start it with: docker compose up -d db"
  exit 1
fi

echo "Exporting to $OUTFILE…"
docker compose exec -T db pg_dump --format=custom --no-owner -U finance finance > "$OUTFILE"
echo "Done. $(du -h "$OUTFILE" | cut -f1) written to $OUTFILE"
