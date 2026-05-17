#!/usr/bin/env bash
# Converts photos/ to JPG and syncs them to the LePotato.
# Usage: bash sync-photos.sh [user@host]
#
# Requires: sips (built-in on macOS), rsync, ssh access to the potato.

set -eo pipefail

POTATO="${1:-ubuntu@192.168.1.100}"
REMOTE_DIR="/home/ubuntu/flight-radar/photos"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)/photos"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}▶  $*${NC}"; }
warn() { echo -e "${YELLOW}⚠  $*${NC}"; }

log "Converting photos to JPG in $TMP_DIR"

shopt -s nullglob
for f in "$SRC_DIR"/*.{jpg,JPG,jpeg,JPEG,heic,HEIC,png,PNG,webp,WEBP}; do
  name="$(basename "$f")"
  ext="${name##*.}"
  base="${name%.*}"
  out="$TMP_DIR/${base}.jpg"

  case "${ext,,}" in
    jpg|jpeg)
      cp "$f" "$out"
      ;;
    heic|png|webp)
      sips -s format jpeg -s formatOptions 90 "$f" --out "$out" &>/dev/null
      echo "  converted $name"
      ;;
    *)
      warn "skipping $name (unsupported)"
      continue
      ;;
  esac
done

count=$(ls "$TMP_DIR"/*.jpg 2>/dev/null | wc -l | tr -d ' ')
log "Syncing $count JPG(s) → ${POTATO}:${REMOTE_DIR}"

ssh "$POTATO" "mkdir -p $REMOTE_DIR"
rsync -avz --delete --include='*.jpg' --exclude='*' "$TMP_DIR/" "${POTATO}:${REMOTE_DIR}/"

log "Done — $count photo(s) on the potato."
