#!/usr/bin/env bash
# Sets up the flight-radar server on LibreComputer LePotato (Ubuntu/Debian ARM64).
# Run from the project directory: sudo bash setup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_USER="${SUDO_USER:-$(logname 2>/dev/null || whoami)}"
PORT="${PORT:-8080}"

# ─── colours ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
step() { echo -e "\n${GREEN}▶  $*${NC}"; }
warn() { echo -e "${YELLOW}⚠  $*${NC}"; }
die()  { echo -e "${RED}✗  $*${NC}" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo:  sudo bash setup.sh"

# ─── 1. Node.js ───────────────────────────────────────────────────────────────
step "Node.js"
if command -v node &>/dev/null && node -e 'process.exit(+process.version.slice(1)<18)' 2>/dev/null; then
  echo "  already installed: $(node --version)"
else
  echo "  installing Node.js 22 LTS via NodeSource…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt install -y nodejs
fi

# ─── 2. Chromium ──────────────────────────────────────────────────────────────
step "Chromium"
# Prefer the real deb package over snap — snap Chromium refuses to launch from
# a systemd service cgroup unless Delegate=yes is set (and even then is flaky).
# The Debian chromium package works reliably without cgroup restrictions.
CHROMIUM_PATH=""
for c in /usr/bin/chromium /usr/bin/chromium-browser; do
  if [[ -x "$c" ]] && "$c" --version &>/dev/null 2>&1; then
    CHROMIUM_PATH="$c"; break
  fi
done

if [[ -z "$CHROMIUM_PATH" ]]; then
  echo "  installing chromium deb…"
  apt install -y chromium 2>/dev/null || apt install -y chromium-browser 2>/dev/null || true
  for c in /usr/bin/chromium /usr/bin/chromium-browser; do
    if [[ -x "$c" ]] && "$c" --version &>/dev/null 2>&1; then
      CHROMIUM_PATH="$c"; break
    fi
  done
fi

# Fall back to snap if deb isn't available (Ubuntu 22.04+ only ships a snap stub)
if [[ -z "$CHROMIUM_PATH" ]]; then
  echo "  deb not available, falling back to snap…"
  if ! snap list chromium &>/dev/null; then
    snap install chromium
  fi
  if [[ -x /snap/bin/chromium ]] && /snap/bin/chromium --version &>/dev/null 2>&1; then
    CHROMIUM_PATH="/snap/bin/chromium"
  fi
fi

[[ -n "$CHROMIUM_PATH" ]] || die "Chromium not found — run: apt install chromium  or  snap install chromium"
echo "  using: $CHROMIUM_PATH"

# ─── 3. npm dependencies ──────────────────────────────────────────────────────
step "npm install"
cd "$SCRIPT_DIR"
# Tell Puppeteer not to download its bundled Chrome during install
PUPPETEER_SKIP_DOWNLOAD=true sudo -u "$SERVICE_USER" npm install

# ─── 4. .env ──────────────────────────────────────────────────────────────────
step ".env"
ENV_FILE="$SCRIPT_DIR/.env"
[[ -f "$ENV_FILE" ]] || die "No .env found in $SCRIPT_DIR — copy one from the repo first"

# Upsert a key=value in .env (add if missing, replace if present)
upsert_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

upsert_env "PUPPETEER_SKIP_DOWNLOAD"    "true"
upsert_env "PUPPETEER_EXECUTABLE_PATH"  "$CHROMIUM_PATH"
upsert_env "PHOTOS_DIR"                 "$SCRIPT_DIR/photos"

# ─── 5. photos directory ──────────────────────────────────────────────────────
step "photos dir"
sudo -u "$SERVICE_USER" mkdir -p "$SCRIPT_DIR/photos"
echo "  $SCRIPT_DIR/photos (drop images here)"

# ─── 6. systemd service ───────────────────────────────────────────────────────
step "systemd service"
cat > /etc/systemd/system/flight-radar.service << EOF
[Unit]
Description=Flight Radar Screen Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${SCRIPT_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
Delegate=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable flight-radar
systemctl restart flight-radar

# ─── 7. verify ────────────────────────────────────────────────────────────────
step "verifying"
sleep 4
if systemctl is-active --quiet flight-radar; then
  IP="$(hostname -I | awk '{print $1}')"
  echo -e "\n${GREEN}✓ Server is running${NC}"
  echo ""
  echo "  Health:  curl http://${IP}:${PORT}/health"
  echo "  Preview: http://${IP}:${PORT}/?preview"
  echo "  Logs:    journalctl -u flight-radar -f"
  echo ""
  echo "  Flash the board with:"
  echo "    BASE_URL = \"http://${IP}:${PORT}\""
else
  warn "Service didn't start — last 30 log lines:"
  journalctl -u flight-radar -n 30 --no-pager
  die "Fix the error above, then: sudo systemctl restart flight-radar"
fi
