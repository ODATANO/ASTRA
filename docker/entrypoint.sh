#!/usr/bin/env bash
# ODATANO ASTRA container entrypoint.
#   serve    – wait for ASTRA's own Postgres, deploy schema (unless ASTRA_DB_DEPLOY=never), start CAP
#   migrate  – deploy schema only
#   check    – print the resolved source configuration and probe the source databases, then exit
set -euo pipefail
cd /app

export CDS_CONFIG
CDS_CONFIG="$(node docker/cds-config.mjs)"

wait_for_pg() {
  local url="$1" name="$2" tries="${ASTRA_DB_WAIT_SECONDS:-60}"
  for ((i = 0; i < tries; i++)); do
    if pg_isready -d "$url" -q 2>/dev/null; then return 0; fi
    sleep 1
  done
  echo "[astra] $name not reachable after ${tries}s: ${url//:\/\/*@/://***@}" >&2
  return 1
}

case "${1:-serve}" in
  serve|migrate)
    wait_for_pg "$ASTRA_DB_URL" "astra-postgres"
    if [[ "${ASTRA_DB_DEPLOY:-always}" != "never" ]]; then
      echo "[astra] deploying schema to astra-postgres"
      npx cds deploy --profile production
    fi
    [[ "$1" == "migrate" ]] && exit 0
    for chain in CARDANO MIDNIGHT; do
      var="ASTRA_${chain}_DB_URL"; url="${!var:-}"
      if [[ -n "$url" && ! "$url" =~ ^(off|false|0|none)$ ]]; then
        wait_for_pg "$url" "source ${chain,,}" || echo "[astra] continuing without ${chain,,} for now (scheduler retries)" >&2
      fi
    done
    exec npx cds-tsx serve --port "${PORT:-4004}"
    ;;
  check)
    node docker/cds-config.mjs --explain
    for chain in CARDANO MIDNIGHT; do
      var="ASTRA_${chain}_DB_URL"; url="${!var:-}"
      [[ -z "$url" || "$url" =~ ^(off|false|0|none)$ ]] && { echo "$chain: off"; continue; }
      if pg_isready -d "$url" -q; then echo "$chain: reachable"; else echo "$chain: NOT reachable"; fi
    done
    ;;
  *)
    exec "$@"
    ;;
esac
