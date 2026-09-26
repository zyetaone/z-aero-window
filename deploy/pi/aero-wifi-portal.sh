#!/bin/bash
# aero-wifi-portal.sh — invoked at boot. Decides:
#
#   IF NetworkManager has no active WiFi connection after a grace period
#   THEN start wifi-connect (creates AP "aero-display-XX-setup", serves
#        branded portal at 192.168.42.1:80, blocks until customer completes
#        WiFi setup or 5 min timeout)
#   ELSE exit 0 quietly so the kiosk app boots normally.
#
# Re-trigger paths:
#   - /api/wifi/reset endpoint deletes saved connections + reboots → no WiFi
#     on next boot → portal mode kicks in here
set -e

# ─── Wait for a network ─────────────────────────────────────────────────────
# ANY route out counts, not only Wi-Fi: a Pi on ethernet, or one whose venue
# Wi-Fi is down at the 04:00 reboot, must not raise a setup AP and hold the
# kiosk behind this oneshot every boot. NM may take a few seconds after boot to
# associate, so give it 30 s before "no network" means "portal".
GRACE=30
echo "[wifi-portal] waiting up to ${GRACE}s for a network…"

deadline=$((SECONDS + GRACE))
while [ $SECONDS -lt $deadline ]; do
  if ip route 2>/dev/null | command grep -q '^default'; then
    echo "[wifi-portal] default route present — exiting"
    exit 0
  fi
  sleep 2
done

# A saved Wi-Fi profile that simply cannot associate right now (AP off, out of
# range) is not "unconfigured": the portal would replace working credentials
# with whatever a passer-by types. Only an EMPTY profile list opens the portal.
saved=$(nmcli -t -f TYPE c 2>/dev/null | command grep -c '^802-11-wireless' || true)
if [ "${saved}" -gt 0 ]; then
  echo "[wifi-portal] ${saved} saved Wi-Fi profile(s), none up — leaving them alone"
  exit 0
fi

# ─── No Wi-Fi configured — launch portal ────────────────────────────────────
SSID="$(hostname)-setup"
echo "[wifi-portal] no Wi-Fi configured; spawning open AP \"${SSID}\""

# Open network (no --portal-passphrase: an empty string is not "none").
# --activity-timeout is REQUIRED: the binary's default is 0 = wait forever, and
# Before=aero-app.service means forever is a wall that never boots. 300 s, then
# the kiosk starts with no network and the next boot offers the portal again.
# The UI directory is wifi-connect's own shipped portal, unpacked by install.sh.
exec /usr/local/bin/wifi-connect \
  --portal-ssid "${SSID}" \
  --activity-timeout 300 \
  --ui-directory /usr/local/share/wifi-portal
