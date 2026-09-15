#!/usr/bin/env bash
# =============================================================================
# health-check.sh — cron-driven Pi health report.
#
# Runs every 60s from /etc/cron.d/aero-health-check. Collects fps (from the
# local app's /api/fleet health endpoint), CPU temperature, and uptime, then
# POSTs to the admin via AERO_ADMIN_URL. If no admin is configured or the
# admin is unreachable, the script silent-fails — cron should never flood
# syslog on a cold network.
#
# Contract with admin:
#   POST ${AERO_ADMIN_URL}/api/fleet/heartbeat
#   Body: { deviceId, role, groupId, fps, temp, uptime, crashCount,
#           throttledRaw, thermalAction, ... }
#
# Thermal load-shed: writes /run/aero/thermal.json for the local kiosk
# (GET /api/internal/thermal). Policy mirrors aero-2/src/lib/throttle.ts
# (thermalAction + THERMAL_SHED_TEMP_C/THERMAL_CLEAR_TEMP_C). The old citation,
# src/lib/fleet/throttle.ts, is an aero-1 path that aero-2 never had.
# =============================================================================

set -u

# Source config (written by install.sh). Defaults are chosen so an
# unconfigured Pi still produces sensible payloads.
if [[ -r /etc/aero/config.env ]]; then
	# shellcheck disable=SC1091
	source /etc/aero/config.env
fi

AERO_ROLE="${AERO_ROLE:-solo}"
AERO_GROUP="${AERO_GROUP:-default}"
AERO_PORT="${AERO_PORT:-3000}"
# Where the heartbeat is POSTed. Defaults to THIS device rather than empty:
# the heartbeat store is per-server and in-memory, so posting to ourselves is
# what makes this Pi's own /admin/fleet/health page work. An empty value meant
# a fresh install had no telemetry anywhere until an operator hand-edited
# config.env — and nothing surfaced that, because the POST below is
# fire-and-forget by design. Point it at a central admin to aggregate a fleet.
AERO_ADMIN_URL="${AERO_ADMIN_URL:-http://localhost:${AERO_PORT}}"
# Shared LAN secret for POST /api/fleet/heartbeat. The route is bearer-gated
# and FAIL-CLOSED: without this header every heartbeat is a 503 and the admin
# health dashboard sits permanently empty while each Pi reports success (the
# curl below swallows errors by design). Provisioned into config.env by
# install.sh.
AERO_FLEET_TOKEN="${AERO_FLEET_TOKEN:-}"
DEVICE_ID="$(hostname)"

# ─── Measurements ────────────────────────────────────────────────────────────

# Uptime in seconds (integer).
if [[ -r /proc/uptime ]]; then
	UPTIME="$(cut -d' ' -f1 /proc/uptime | cut -d'.' -f1)"
else
	UPTIME=0
fi

# CPU temperature in °C. Pi thermal_zone0 reports millidegrees.
TEMP_C=0
if [[ -r /sys/class/thermal/thermal_zone0/temp ]]; then
	TEMP_MILLI="$(cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo 0)"
	TEMP_C=$(( TEMP_MILLI / 1000 ))
fi

# ─── Clock synchronisation ───────────────────────────────────────────────────
# The ENTIRE panorama is a function of the wall clock. Pose, sun position, the
# director's rotation slot, the cloud gusts and the scheduled `applyAtWallSec`
# of a wall push are all derived from `Date.now()` on each Pi independently —
# that is the design (ADR-007: no bus, no shared state, agree by deriving). It
# only holds while the three clocks agree.
#
# An unsynced Pi therefore does not fail loudly. It flies a different part of
# the orbit, lights a different time of day, and applies an operator's push
# seconds early or late, while every other check here reports green. On a
# continuous three-pane window that reads as "the middle screen is broken",
# with nothing in any log to say why.
#
# `display-dim-schedule.sh` already waits for NTP before trusting the hour, for
# a strictly smaller reason (dimming at the wrong time). The heartbeat did not
# report it at all, so the fleet had no way to see the condition that matters
# most to the product. Reported, not enforced: this script observes, and a
# device that has genuinely lost NTP still shows a window.
CLOCK_SYNCED=0
if command -v timedatectl >/dev/null 2>&1; then
	if [[ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" == "yes" ]]; then
		CLOCK_SYNCED=1
	fi
else
	# No timedatectl (a container, a non-systemd image): unknowable rather than
	# false. -1 so a dashboard can tell "not synced" from "cannot tell".
	CLOCK_SYNCED=-1
fi

# ─── Thermal / power throttle (vcgencmd get_throttled) ───────────────────────
# Bitfield: 0 under-voltage, 1 freq-capped, 2 throttled, 3 soft-temp (live);
# 16–19 sticky "has occurred since boot". Policy matches src/lib/server/fleet/throttle.ts:
# shed GPU load at ≥78 °C or any live pressure bit; clear only ≤70 °C (hysteresis).
THROTTLED_RAW=0
if command -v vcgencmd >/dev/null 2>&1; then
	# Output looks like: throttled=0x50000
	THROTTLE_LINE="$(vcgencmd get_throttled 2>/dev/null || true)"
	THROTTLE_HEX="$(echo "${THROTTLE_LINE}" | sed -n 's/.*throttled=\(0x[0-9a-fA-F]*\).*/\1/p')"
	if [[ -n "${THROTTLE_HEX}" ]]; then
		THROTTLED_RAW=$(( THROTTLE_HEX ))
	fi
fi
# Live pressure bits 0–3.
LIVE_PRESSURE=0
if (( (THROTTLED_RAW & 0xF) != 0 )); then
	LIVE_PRESSURE=1
fi

# Hysteresis file so we do not flap quality mode at the threshold.
THERMAL_STATE_DIR="${AERO_THERMAL_DIR:-/run/aero}"
THERMAL_STATE_FILE="${THERMAL_STATE_DIR}/thermal.json"
THERMAL_SHED_C="${AERO_THERMAL_SHED_C:-78}"
THERMAL_CLEAR_C="${AERO_THERMAL_CLEAR_C:-70}"
PREV_ACTION="ok"
if [[ -r "${THERMAL_STATE_FILE}" ]]; then
	PREV_ACTION="$(tr ',' '\n' < "${THERMAL_STATE_FILE}" | command grep -o '"action":"[^"]*"' | head -1 | cut -d'"' -f4 || echo ok)"
	PREV_ACTION="${PREV_ACTION:-ok}"
fi
THERMAL_ACTION="ok"
if (( LIVE_PRESSURE == 1 )) || (( TEMP_C >= THERMAL_SHED_C )); then
	THERMAL_ACTION="shed"
elif [[ "${PREV_ACTION}" == "shed" ]] && (( TEMP_C > THERMAL_CLEAR_C )); then
	THERMAL_ACTION="shed"
fi

# Atomic-ish write for the kiosk (GET /api/internal/thermal, loopback only).
if mkdir -p "${THERMAL_STATE_DIR}" 2>/dev/null; then
	NOW_MS="$(( $(date +%s) * 1000 ))"
	# flags object is decoded again in TS; raw + action are load-bearing.
	cat > "${THERMAL_STATE_FILE}.tmp" <<TEOF
{"tempC":${TEMP_C},"throttledRaw":${THROTTLED_RAW},"action":"${THERMAL_ACTION}","updatedAtMs":${NOW_MS}}
TEOF
	mv -f "${THERMAL_STATE_FILE}.tmp" "${THERMAL_STATE_FILE}" 2>/dev/null || true
fi

# FPS + running commit + display mode — scrape the device's own /api/status
# (the browser heartbeats there every 5s). If the app is down, default to 0
# so the admin sees it as failing.
FPS=0
COMMIT=""
MODE=""
if command -v curl >/dev/null 2>&1; then
	STATUS_JSON="$(curl -fsS --max-time 2 "http://localhost:${AERO_PORT}/api/status" 2>/dev/null || echo '{}')"
	# Cheap JSON scrapes without a jq dependency.
	FPS="$(echo "${STATUS_JSON}" | tr ',' '\n' | command grep -o '"fps":[0-9.]*' | head -1 | cut -d':' -f2 || echo 0)"
	FPS="${FPS:-0}"
	COMMIT="$(echo "${STATUS_JSON}" | tr ',' '\n' | command grep -o '"commit":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
	MODE="$(echo "${STATUS_JSON}" | tr ',' '\n' | command grep -o '"mode":"[^"]*"' | head -1 | cut -d'"' -f4 || true)"
fi

# Last error line from the app service journal — one line of WHY, not just
# a crash count. Escaped for JSON embedding (quotes/backslashes stripped).
LAST_ERROR=""
if command -v journalctl >/dev/null 2>&1; then
	LAST_ERROR="$(journalctl -u aero-app.service -p err -n 1 --no-pager -o cat 2>/dev/null \
		| head -c 200 | tr -d '"\\' || true)"
fi

# Crash count — increment whenever aero-kiosk.service failed since boot.
CRASH_COUNT=0
if command -v systemctl >/dev/null 2>&1; then
	CRASH_COUNT="$(systemctl show aero-kiosk.service -p NRestarts --value 2>/dev/null || echo 0)"
	CRASH_COUNT="${CRASH_COUNT:-0}"
fi

# ─── POST to admin ───────────────────────────────────────────────────────────

PAYLOAD=$(cat <<EOF
{"deviceId":"${DEVICE_ID}","role":"${AERO_ROLE}","groupId":"${AERO_GROUP}","fps":${FPS},"temp":${TEMP_C},"uptime":${UPTIME},"crashCount":${CRASH_COUNT},"commit":"${COMMIT}","lastError":"${LAST_ERROR}","mode":"${MODE}","throttledRaw":${THROTTLED_RAW},"thermalAction":"${THERMAL_ACTION}","clockSynced":${CLOCK_SYNCED}}
EOF
)

if [[ -n "${AERO_ADMIN_URL}" ]] && command -v curl >/dev/null 2>&1; then
	# Two explicit branches rather than an "${ARGS[@]}" array: this script runs
	# under `set -u`, and expanding an EMPTY array that way is an unbound-variable
	# error on bash < 4.4 (still the default /bin/bash on some hosts). A health
	# check must not be the thing that breaks on an old shell.
	if [[ -n "${AERO_FLEET_TOKEN}" ]]; then
		curl -fsS --max-time 3 -X POST \
			-H "Content-Type: application/json" \
			-H "Authorization: Bearer ${AERO_FLEET_TOKEN}" \
			-d "${PAYLOAD}" \
			"${AERO_ADMIN_URL}/api/fleet/heartbeat" >/dev/null 2>&1 || true
	else
		curl -fsS --max-time 3 -X POST \
			-H "Content-Type: application/json" \
			-d "${PAYLOAD}" \
			"${AERO_ADMIN_URL}/api/fleet/heartbeat" >/dev/null 2>&1 || true
	fi
fi

# Always exit 0 — a health check that fails the cron job just creates noise.
exit 0
