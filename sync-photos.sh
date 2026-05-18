#!/usr/bin/env bash
# Converts photos/ to JPG and syncs them to the LePotato.
# Usage: bash sync-photos.sh [user@host]
#
# Requires: sips (built-in on macOS), rsync, ssh access to the potato.

set -eo pipefail

POTATO="${1:-ubuntu@192.168.1.100}"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)/photos"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}▶  $*${NC}"; }
warn() { echo -e "${YELLOW}⚠  $*${NC}"; }

# Read PHOTOS_DIR from the potato's .env
REMOTE_DIR="$(ssh "$POTATO" 'grep "^PHOTOS_DIR=" /srv/flightradar/.env 2>/dev/null | cut -d= -f2' 2>/dev/null || true)"
REMOTE_DIR="${REMOTE_DIR:-/srv/flightradar/photos}"
log "Remote dir: $REMOTE_DIR"

log "Converting photos in $SRC_DIR"

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
      warn "skipping $name"
      continue
      ;;
  esac
done

count=$(ls "$TMP_DIR"/*.jpg 2>/dev/null | wc -l | tr -d ' ')
if [ "$count" -eq 0 ]; then
  warn "No photos found in $SRC_DIR"
  exit 1
fi

log "Syncing $count JPG(s) to ${POTATO}:${REMOTE_DIR}"
ssh "$POTATO" "sudo mkdir -p '$REMOTE_DIR'"
rsync -avz --delete "$TMP_DIR/" "${POTATO}:${REMOTE_DIR}/"

log "Done — $count photo(s) synced."
