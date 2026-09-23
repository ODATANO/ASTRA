#!/usr/bin/env bash
# Step 1: tar the working tree (no node_modules, no .env, no local databases)
# and copy it into /root/odatano-astra on the box; then run
# scripts/deploy-on-box.sh there (build + start). The box's .env is kept.
#   bash scripts/upload-to-box.sh root@<box>
#   ssh root@<box> 'bash -s' < scripts/deploy-on-box.sh
set -euo pipefail
cd "$(dirname "$0")/.."
BOX="${1:?usage: bash scripts/upload-to-box.sh user@host}"
OUT="/tmp/odatano-astra-src.tgz"
tar --force-local \
    --exclude='./node_modules' --exclude='./.git' --exclude='./.env' --exclude='./.env.*' \
    --exclude='./db.sqlite*' --exclude='./sources/*.sqlite*' --exclude='./dist' --exclude='./gen' \
    --exclude='./@cds-models' --exclude='./coverage' --exclude='./*.log' \
    --exclude='./CLAUDE.md' --exclude='./CONCEPT.md' --exclude='./.vscode' \
    -czf "$OUT" .
ls -la "$OUT"
scp "$OUT" "$BOX:/root/odatano-astra-src.tgz"
ssh "$BOX" 'mkdir -p /root/odatano-astra && tar -xzf /root/odatano-astra-src.tgz -C /root/odatano-astra && rm /root/odatano-astra-src.tgz && grep -n "@path" /root/odatano-astra/srv/astra-service.cds && ls /root/odatano-astra/app/og-image.png'
echo "uploaded; now: ssh $BOX 'bash -s' < scripts/deploy-on-box.sh"
