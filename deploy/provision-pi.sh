#!/usr/bin/env bash
# =============================================================================
# Zyeta Aero — Pi 5 Provisioning Script
#
# Sets up a Raspberry Pi 5 as an Aero Dynamic Window kiosk display.
# Run as root: sudo bash provision-pi.sh [SERVER_HOST] [DEVICE_NAME]
#
# Prerequisites: Fresh Raspberry Pi OS (64-bit Lite or Desktop)
# =============================================================================

set -euo pipefail

SERVER_HOST="${1:-aero-server.local}"
DEVICE_NAME="${2:-aero-display-$(hostname)}"
DISPLAY_URL="http://${SERVER_HOST}:5173?device=${DEVICE_NAME}"
INSTALL_DIR="/opt/zyeta-aero"

echo "============================================"
echo "  Zyeta Aero — Pi 5 Kiosk Provisioner"
echo "============================================"
echo "Server:  ${SERVER_HOST}"
echo "Device:  ${DEVICE_NAME}"
echo "URL:     ${DISPLAY_URL}"
echo ""

# ─── 1. System Update ────────────────────────────────────────────────────────

echo "[1/7] Updating system packages..."
apt-get update -qq
apt-get upgrade -y -qq

# ─── 2. Install Dependencies ─────────────────────────────────────────────────

echo "[2/7] Installing Chromium and dependencies..."
apt-get install -y -qq \
    chromium-browser \
    xserver-xorg \
    x11-xserver-utils \
    xinit \
    unclutter \
    fonts-noto \
    fonts-noto-color-emoji

# ─── 3. Configure GPU ────────────────────────────────────────────────────────

echo "[3/7] Configuring GPU settings..."

# Ensure KMS overlay for VideoCore VII
if ! grep -q "dtoverlay=vc4-kms-v3d" /boot/firmware/config.txt 2>/dev/null; then
    echo "dtoverlay=vc4-kms-v3d" >> /boot/firmware/config.txt
fi

# Increase GPU memory allocation
if grep -q "^gpu_mem=" /boot/firmware/config.txt 2>/dev/null; then
    sed -i 's/^gpu_mem=.*/gpu_mem=256/' /boot/firmware/config.txt
else
    echo "gpu_mem=256" >> /boot/firmware/config.txt
fi

# ─── 4. Create Kiosk User ────────────────────────────────────────────────────

echo "[4/7] Setting up kiosk user..."
if ! id -u kiosk &>/dev/null; then
    useradd -m -s /bin/bash kiosk
    usermod -aG video,render,input kiosk
fi

# ─── 5. Install Bun Runtime (for tile server) ─────────────────────────────

echo "[5/8] Installing Bun runtime..."
if ! command -v bun &>/dev/null; then
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="/home/kiosk/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
fi

# ─── 5b. Create Install Directory ────────────────────────────────────────────

echo "[5/7] Creating configuration..."
mkdir -p "${INSTALL_DIR}"

# Write kiosk configuration
cat > "${INSTALL_DIR}/config.env" <<EOF
# Zyeta Aero Kiosk Configuration
DISPLAY_URL=${DISPLAY_URL}
SERVER_HOST=${SERVER_HOST}
DEVICE_NAME=${DEVICE_NAME}
EOF

# Chromium kiosk launch script
cat > "${INSTALL_DIR}/start-kiosk.sh" <<'KIOSK_SCRIPT'
#!/usr/bin/env bash
# Zyeta Aero Kiosk — Chromium Launch Script

source /opt/zyeta-aero/config.env

# Wait for X server
while ! xdpyinfo -display :0 &>/dev/null; do
    sleep 1
done

# Disable screen blanking
xset -display :0 s off
xset -display :0 -dpms
xset -display :0 s noblank

# Hide cursor after 3 seconds of inactivity
unclutter -display :0 -idle 3 -root &

# Clear Chromium crash flags (prevents "restore session" prompt)
CHROMIUM_DIR="/home/kiosk/.config/chromium"
mkdir -p "${CHROMIUM_DIR}/Default"
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/' \
    "${CHROMIUM_DIR}/Default/Preferences" 2>/dev/null || true
sed -i 's/"exit_type":"Crashed"/"exit_type":"Normal"/' \
    "${CHROMIUM_DIR}/Default/Preferences" 2>/dev/null || true

# Launch Chromium in kiosk mode with GPU flags
exec chromium-browser \
    --kiosk \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-features=TranslateUI \
    --check-for-update-interval=31536000 \
    --ignore-gpu-blocklist \
    --enable-gpu-rasterization \
    --enable-zero-copy \
    --use-gl=egl \
    --disable-software-rasterizer \
    --enable-features=VaapiVideoDecoder \
    --disable-background-networking \
    --disable-component-update \
    --autoplay-policy=no-user-gesture-required \
    --window-size=1920,1080 \
    --window-position=0,0 \
    "${DISPLAY_URL}"
KIOSK_SCRIPT

chmod +x "${INSTALL_DIR}/start-kiosk.sh"

# ─── 6. Install systemd Services ─────────────────────────────────────────────

echo "[6/7] Installing systemd services..."

# X server service (minimal, no desktop environment)
cat > /etc/systemd/system/aero-xserver.service <<EOF
[Unit]
Description=Zyeta Aero X Server
After=systemd-user-sessions.service

[Service]
Type=simple
User=kiosk
Environment=DISPLAY=:0
ExecStart=/usr/bin/xinit /bin/bash -c "sleep infinity" -- :0 -nolisten tcp vt1
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Chromium kiosk service
cat > /etc/systemd/system/aero-display.service <<EOF
[Unit]
Description=Zyeta Aero Display Kiosk
After=aero-xserver.service network-online.target
Wants=network-online.target
Requires=aero-xserver.service

[Service]
Type=simple
User=kiosk
Environment=DISPLAY=:0
ExecStartPre=/bin/sleep 3
ExecStart=${INSTALL_DIR}/start-kiosk.sh
Restart=always
RestartSec=10
WatchdogSec=120
TimeoutStartSec=30

[Install]
WantedBy=multi-user.target
EOF

# Tile server — serves pre-cached map tiles for offline Cesium operation
cat > /etc/systemd/system/aero-tiles.service <<EOF
[Unit]
Description=Zyeta Aero Tile Server
After=local-fs.target

[Service]
Type=simple
User=kiosk
Environment=TILE_DIR=/opt/zyeta-aero/tiles
Environment=TILE_PORT=8888
Environment=HOME=/home/kiosk
ExecStart=/home/kiosk/.bun/bin/bun run /opt/zyeta-aero/tile-server/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# OTA updater — checks for code updates daily
cp "${INSTALL_DIR}/app/deploy/aero-updater.sh" "${INSTALL_DIR}/aero-updater.sh" 2>/dev/null || true

cat > /etc/systemd/system/aero-updater.service <<EOF
[Unit]
Description=Zyeta Aero OTA Updater
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=AERO_BRANCH=main
Environment=AERO_FLEET_SERVER=${SERVER_HOST}
ExecStart=/bin/bash /opt/zyeta-aero/aero-updater.sh
StandardOutput=journal
StandardError=journal
EOF

cat > /etc/systemd/system/aero-updater.timer <<EOF
[Unit]
Description=Zyeta Aero Daily Update Check

[Timer]
OnBootSec=5min
OnCalendar=*-*-* 03:00:00
Persistent=true
RandomizedDelaySec=1800
Unit=aero-updater.service

[Install]
WantedBy=timers.target
EOF

# Watchdog timer — restarts if Chromium is hung
cat > /etc/systemd/system/aero-watchdog.service <<EOF
[Unit]
Description=Zyeta Aero Watchdog
After=aero-display.service

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'systemctl is-active aero-display.service || systemctl restart aero-display.service'
EOF

cat > /etc/systemd/system/aero-watchdog.timer <<EOF
[Unit]
Description=Zyeta Aero Watchdog Timer

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Unit=aero-watchdog.service

[Install]
WantedBy=timers.target
EOF

# Pre-seed tiles from SD card or fleet server
echo "  Pre-seeding tiles..."
mkdir -p /opt/zyeta-aero/tiles
if [ -d "/boot/firmware/aero-tiles" ]; then
    echo "  Copying tiles from SD card..."
    cp -r /boot/firmware/aero-tiles/* /opt/zyeta-aero/tiles/
elif curl -s --max-time 5 "http://${SERVER_HOST}:3001/api/health" > /dev/null 2>&1; then
    echo "  Fleet server reachable — tiles will be fetched on first boot"
fi
chown -R kiosk:kiosk /opt/zyeta-aero/tiles

# Copy tile server script
mkdir -p /opt/zyeta-aero/tile-server
# In production, copy the built tile-server here
# For now, create a minimal inline version
cat > /opt/zyeta-aero/tile-server/index.ts <<'TILE_SERVER'
const DIR = process.env.TILE_DIR || '/opt/zyeta-aero/tiles';
const PORT = parseInt(process.env.TILE_PORT || '8888', 10);
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' };
Bun.serve({ port: PORT, async fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === '/health') return Response.json({ status: 'ok' }, { headers: CORS });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const file = Bun.file(`${DIR}${url.pathname}`);
  if (await file.exists()) return new Response(file, { headers: { ...CORS, 'Cache-Control': 'public, max-age=31536000, immutable' } });
  return new Response('Not found', { status: 404, headers: CORS });
}});
console.log(`[tile-server] http://localhost:${PORT}`);
TILE_SERVER

# Enable services
systemctl daemon-reload
systemctl enable aero-xserver.service
systemctl enable aero-tiles.service
systemctl enable aero-display.service
systemctl enable aero-watchdog.timer
systemctl enable aero-updater.timer

# ─── 7. Set Hostname ─────────────────────────────────────────────────────────

echo "[7/7] Setting hostname to ${DEVICE_NAME}..."
hostnamectl set-hostname "${DEVICE_NAME}"

echo ""
echo "============================================"
echo "  Provisioning complete!"
echo "============================================"
echo ""
echo "The display will auto-start on next boot."
echo "To start now:  sudo systemctl start aero-xserver && sudo systemctl start aero-display"
echo "To check logs: journalctl -u aero-display -f"
echo ""
echo "Reboot recommended: sudo reboot"
