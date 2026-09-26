#!/usr/bin/env bash
# =============================================================================
# Aero Window — Pi 5 one-shot installer (idempotent).
#
# For corridor deployment (3 Pis × 2 corridors = 6 devices). Designed so a
# fresh Raspberry Pi OS Bookworm install, given network, can reach a working
# kiosk within ~10 min (plus tile cache download time).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/zyetaone/z-aero-window/main/deploy/pi/install.sh | bash
#   # or, locally:
#   sudo bash deploy/pi/install.sh [--role left|center|right|solo] [--group corridor-a]
#
# Design goals:
#   1. Idempotent — re-running on an already-configured Pi is safe and fast.
#   2. No destructive operations (no `rm -rf`, no `--force` git).
#   3. Clone once, apt-get once per package, systemd-enable once per unit.
#   4. All failure paths leave the Pi in a recoverable state.
# =============================================================================

set -euo pipefail

# ─── Argument parsing ───────────────────────────────────────────────────────

AERO_ROLE="${AERO_ROLE:-solo}"
AERO_GROUP="${AERO_GROUP:-default}"
REPO_URL="${AERO_REPO_URL:-https://github.com/zyetaone/z-aero-window.git}"
# `release`, not `main`: release is fast-forwarded by CI only after check +
# tests + build + smoke-test pass, so a fresh install lands on a commit that was
# individually proven, the same one the updater would converge it to within
# ~3 min anyway (aero-updater.timer OnBootSec=3min). Defaulting to main meant a
# new Pi briefly ran a commit whose own CI run may never have completed — a
# narrow window, but a pointless one when the gated branch is right there.
# Pass --branch main (or AERO_REPO_BRANCH=main) for a dev/test install.
REPO_BRANCH="${AERO_REPO_BRANCH:-release}"
INSTALL_DIR="/opt/aero-window"
PI_USER="${SUDO_USER:-pi}"
BUN_BIN="/home/${PI_USER}/.bun/bin/bun"
# Pre-git hand-copied layout found on the first fielded Pi. Only read from —
# never modified or removed — so a failed migration leaves it intact.
LEGACY_DIR="/home/${PI_USER}/aero-window"

# --units-only: reinstall ONLY the systemd units, helper scripts and cron
# entries, skipping apt / bun / clone / build / config.env and the boot-partition
# branding. This is the OTA path: aero-updater.sh calls it when a release changed
# anything under deploy/, because `git pull` updates deploy/pi/*.service in the
# REPO but nothing ever copied them to /etc/systemd/system — so unit-level fixes
# (GPU flags, VT handling, ExecStart changes) reached devices and did nothing.
# Deliberately excluded here: apt (slow, needs network), the build (the updater
# just did it), config.env (would clobber hand-set tokens), and the cmdline.txt /
# config.txt rewrites (a bad boot-partition edit is an unbootable Pi and the
# updater's git-only rollback cannot undo it — that stays a human, on-console act).
UNITS_ONLY=false

# One-time backup of a boot-partition file before this script first edits it.
# The header above notes that a bad boot-partition edit is an unbootable Pi and
# the updater's git-only rollback cannot undo it — so leave the operator a copy
# they can restore from a rescue boot or by pulling the SD card.
#
# `.aero-orig` (not a timestamped name) on purpose: this must capture the
# PRE-AERO state exactly once. Re-provisioning a device that already has our
# tokens applied would otherwise overwrite the pristine copy with a modified
# one, which is the moment the backup stops being worth anything.
backup_boot_file() {
	local f="$1"
	[[ -f "${f}" ]] || return 0
	[[ -e "${f}.aero-orig" ]] && return 0
	cp -p "${f}" "${f}.aero-orig" 2>/dev/null \
		&& echo "      + backed up $(basename "${f}") → $(basename "${f}").aero-orig" \
		|| echo "      ! could not back up ${f} (continuing)"
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--role)   AERO_ROLE="$2"; shift 2 ;;
		--group)  AERO_GROUP="$2"; shift 2 ;;
		--branch) REPO_BRANCH="$2"; shift 2 ;;
		--units-only) UNITS_ONLY=true; shift ;;
		--app)    AERO_APP_SUBDIR="$2"; shift 2 ;;
		--help|-h)
			echo "Usage: install.sh [--role left|center|right|solo] [--group <id>] [--branch <git-branch>] [--app aero-1|aero-2] [--units-only]"
			exit 0 ;;
		*)  echo "Unknown argument: $1" >&2; exit 1 ;;
	esac
done

if [[ $EUID -ne 0 ]]; then
	echo "This script must be run as root (sudo)." >&2
	exit 1
fi

# Which application this Pi runs. The repo holds two (aero-1/, aero-2/) and the
# root has no package.json, so the choice must be explicit and it must be made
# BEFORE step 4 builds — the build used to run at INSTALL_DIR, which has nothing
# to build, and the updater's fallback chain then served aero-1 to a Pi that was
# meant to run aero-2. Precedence: --app / AERO_APP_SUBDIR, then whatever this
# Pi's config.env already says (so --units-only never flips a fielded Pi), then
# aero-2 for a fresh install. The value is written into config.env by step 5
# and read by aero-updater.sh on every run; it is deliberately NOT in the
# additive block below, so an OTA run cannot cut a fielded aero-1 Pi over.
if [[ -z "${AERO_APP_SUBDIR:-}" && -f /etc/aero/config.env ]]; then
	AERO_APP_SUBDIR="$(command grep -oP '^AERO_APP_SUBDIR=\K.*' /etc/aero/config.env 2>/dev/null || true)"
fi
if [[ -z "${AERO_APP_SUBDIR:-}" ]]; then
	if [[ -f "${INSTALL_DIR}/aero-1/build/index.js" && ! -f "${INSTALL_DIR}/aero-2/build/index.js" ]]; then
		AERO_APP_SUBDIR="aero-1"   # fielded Pi with no record: keep what it runs; --app aero-2 is the cutover
	else
		AERO_APP_SUBDIR="aero-2"
	fi
fi
APP_DIR="${INSTALL_DIR}/${AERO_APP_SUBDIR}"

echo "============================================"
echo "  Aero Window — Pi 5 Installer"
echo "============================================"
echo "Role:    ${AERO_ROLE}"
echo "Group:   ${AERO_GROUP}"
echo "Branch:  ${REPO_BRANCH}"
echo "User:    ${PI_USER}"
echo "Target:  ${INSTALL_DIR}"
echo "App:     ${AERO_APP_SUBDIR}"
echo ""

if [[ "${UNITS_ONLY}" == true ]]; then
	echo "--units-only: skipping packages / bun / clone / build / config.env."
	echo ""
fi

if [[ "${UNITS_ONLY}" == false ]]; then

# ─── Step 1: System packages (idempotent — apt-get only upgrades what changed) ──

echo "[1/7] Installing system packages..."
apt-get update -qq
# No `-y upgrade` — leave OS patching to the operator's maintenance window.
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
	chromium \
	xserver-xorg \
	x11-xserver-utils \
	xinit \
	unclutter \
	openbox \
	network-manager \
	ddcutil \
	curl \
	git \
	ca-certificates \
	fonts-noto \
	fonts-ubuntu \
	fonts-jetbrains-mono \
	plymouth \
	cron \
	logrotate

# fonts-ubuntu + fonts-jetbrains-mono are NOT optional: the app declares both
# (shell HUD, TelemetryOverlay, BootLockup). Pi OS ships neither, so without
# them every panel silently falls back to DejaVu and the boot splash stops
# matching the app's first frame. plymouth carries the boot theme below.

# ─── Step 2: Bun runtime (installs only if missing) ───────────────────────────

echo "[2/7] Installing Bun runtime..."
if [[ ! -x "${BUN_BIN}" ]]; then
	sudo -u "${PI_USER}" bash -c 'curl -fsSL https://bun.sh/install | bash'
else
	echo "  bun already installed at ${BUN_BIN}"
fi

# ─── Step 3: Clone repo (idempotent — fetch+checkout if already present) ──────

echo "[3/7] Fetching app source..."
mkdir -p "${INSTALL_DIR}"
chown "${PI_USER}:${PI_USER}" "${INSTALL_DIR}"

if [[ -d "${INSTALL_DIR}/.git" ]]; then
	echo "  repo present — fetching latest on ${REPO_BRANCH}"
	# Explicit refspec + checkout -B: the initial clone is single-branch, so a
	# plain fetch never materialises a DIFFERENT branch, plain checkout then
	# fails (pathspec), and pull --ff-only breaks after any force-push.
	sudo -u "${PI_USER}" git -C "${INSTALL_DIR}" fetch origin "+refs/heads/${REPO_BRANCH}:refs/remotes/origin/${REPO_BRANCH}"
	sudo -u "${PI_USER}" git -C "${INSTALL_DIR}" checkout -B "${REPO_BRANCH}" "origin/${REPO_BRANCH}"
else
	sudo -u "${PI_USER}" git clone --branch "${REPO_BRANCH}" --depth 20 "${REPO_URL}" "${INSTALL_DIR}"
fi

# ─── Step 4: Build-time env + bun install + build ─────────────────────────────

echo "[4/7] Installing dependencies + building..."

# VITE_* vars are INLINED AT BUILD TIME (src/lib/world/cesium-setup.ts reads
# import.meta.env.VITE_CESIUM_ION_TOKEN). This does not fail loudly once — the
# updater rebuilds on EVERY release, so a missing .env silently ships a
# tokenless build (no Ion terrain, no Ion imagery) forever. .env is gitignored,
# so seeding it once survives the updater's `git reset --hard`.
if [[ -f "${INSTALL_DIR}/.env" ]]; then
	echo "  .env present — leaving as-is"
elif [[ -n "${VITE_CESIUM_ION_TOKEN:-}" ]]; then
	printf 'VITE_CESIUM_ION_TOKEN=%s\n' "${VITE_CESIUM_ION_TOKEN}" > "${INSTALL_DIR}/.env"
	chown "${PI_USER}:${PI_USER}" "${INSTALL_DIR}/.env"
	chmod 600 "${INSTALL_DIR}/.env"
	echo "  wrote .env from VITE_CESIUM_ION_TOKEN"
elif [[ -f "${LEGACY_DIR}/.env" ]]; then
	install -m 600 -o "${PI_USER}" -g "${PI_USER}" "${LEGACY_DIR}/.env" "${INSTALL_DIR}/.env"
	echo "  migrated .env from ${LEGACY_DIR}"
else
	echo "  WARNING: no .env and no VITE_CESIUM_ION_TOKEN in the environment."
	echo "           Cesium Ion terrain + imagery will be DISABLED in this build."
	echo "           Re-run as: sudo VITE_CESIUM_ION_TOKEN=... bash $0 ..."
fi

sudo -u "${PI_USER}" bash -c "cd '${APP_DIR}' && '${BUN_BIN}' install"
# VITE_* are compile-time in Vite, so they must be present HERE — this build
# runs before /etc/aero/config.env is written (step 5), and would otherwise
# bake in "no local tile server" no matter what config.env later says. Passed
# inside the bash -c string because sudo scrubs the caller's environment.
# Same default as TILE_SERVER_URL_VALUE in step 5; the two are re-derived
# rather than shared because that block has not run yet at this point.
# AERO_MEDIA_ORIGINS is read here for the same reason and with the same trap:
# it becomes the CSP media-src directive, which is baked into the built server.
# An operator sets it in /etc/aero/config.env; it takes effect at the NEXT
# build, i.e. the next OTA run. Setting it alone changes nothing until then,
# and a cross-origin track with no matching directive is blocked SILENTLY --
# no console error, no sound, indistinguishable from a push that never landed.
# PUBLIC_WALL_ORIGIN is declared `static: true` in src/env.ts, so it is INLINED
# at build time exactly like the two above -- writing it to config.env alone
# changes nothing. Empty is the correct default (a pane polls itself); set it
# on the two follower panes and leave the writer's empty.
EXISTING_MEDIA_ORIGINS=""
EXISTING_WALL_ORIGIN=""
if [[ -f /etc/aero/config.env ]]; then
	EXISTING_MEDIA_ORIGINS="$(command grep -oP '^AERO_MEDIA_ORIGINS=\K.*' /etc/aero/config.env 2>/dev/null || true)"
	EXISTING_WALL_ORIGIN="$(command grep -oP '^PUBLIC_WALL_ORIGIN=\K.*' /etc/aero/config.env 2>/dev/null || true)"
fi
sudo -u "${PI_USER}" bash -c "cd '${APP_DIR}' && VITE_TILE_SERVER_URL='${VITE_TILE_SERVER_URL:-/api/tiles}' AERO_MEDIA_ORIGINS='${AERO_MEDIA_ORIGINS:-${EXISTING_MEDIA_ORIGINS}}' PUBLIC_WALL_ORIGIN='${PUBLIC_WALL_ORIGIN:-${EXISTING_WALL_ORIGIN}}' '${BUN_BIN}' run build"

# ─── Step 5: Write environment config ─────────────────────────────────────────

echo "[5/7] Writing environment config..."
install -d -m 755 -o "${PI_USER}" -g "${PI_USER}" /etc/aero
# Preserve hand-configured secrets across re-runs — regenerating this file
# used to wipe them. AERO_ADMIN_URL silently killed the WAN heartbeat;
# AERO_ADMIN_TOKEN silently 503s every admin endpoint (requireAdminToken is
# fail-closed), which looks like a broken app rather than a wiped config.
EXISTING_ADMIN_URL=""
EXISTING_ADMIN_TOKEN=""
EXISTING_ION_TOKEN=""
EXISTING_FLEET_TOKEN=""
EXISTING_WIFI_RESET_TOKEN=""
if [[ -r /etc/aero/config.env ]]; then
	EXISTING_ADMIN_URL="$(command grep -oP '^AERO_ADMIN_URL=\K.*' /etc/aero/config.env 2>/dev/null || true)"
	EXISTING_ADMIN_TOKEN="$(command grep -oP '^AERO_ADMIN_TOKEN=\K.*' /etc/aero/config.env 2>/dev/null || true)"
	EXISTING_ION_TOKEN="$(command grep -oP '^CESIUM_ION_TOKEN=\K.*' /etc/aero/config.env 2>/dev/null || true)"
	EXISTING_FLEET_TOKEN="$(command grep -oP '^AERO_FLEET_TOKEN=\K.*' /etc/aero/config.env 2>/dev/null || true)"
	EXISTING_WIFI_RESET_TOKEN="$(command grep -oP '^AERO_WIFI_RESET_TOKEN=\K.*' /etc/aero/config.env 2>/dev/null || true)"
fi

# Central heartbeat collector, e.g.
#   AERO_ADMIN_URL=http://collector:3000 AERO_FLEET_TOKEN=<shared> \
#     bash deploy/pi/install.sh --role center --group wall-1
#
# Env override on a FRESH install only, mirroring AERO_FLEET_TOKEN below (an
# existing value always wins, so re-runs never clobber a hand-tuned config).
# Without this there was no way to aim a new Pi at a collector during install:
# health-check.sh then defaults to posting at THIS device, where the samples
# land in a per-server in-memory store that nothing aggregates. Every Pi looks
# healthy on its own /admin/fleet/health page while the fleet view stays empty.
if [[ -z "${EXISTING_ADMIN_URL}" && -n "${AERO_ADMIN_URL:-}" ]]; then
	EXISTING_ADMIN_URL="${AERO_ADMIN_URL}"
fi

# Shared LAN secret for the telemetry heartbeat. Distinct from
# AERO_ADMIN_TOKEN so health-check.sh holds a credential that can only report
# metrics, never push scenes or trigger an OTA.
#
# AUTO-GENERATED rather than left blank: POST /api/fleet/heartbeat is
# fail-closed, so an unset token means every heartbeat 503s and the fleet
# health dashboard is permanently empty — while each Pi looks fine locally,
# because health-check.sh swallows curl errors on purpose. A silent monitoring
# blackout is worse than a generated secret. Operators who want a fleet-wide
# shared value can overwrite it; re-runs preserve whatever is already there.
if [[ -z "${EXISTING_FLEET_TOKEN}" ]]; then
	if [[ -n "${AERO_FLEET_TOKEN:-}" ]]; then
		EXISTING_FLEET_TOKEN="${AERO_FLEET_TOKEN}"
	elif command -v openssl >/dev/null 2>&1; then
		EXISTING_FLEET_TOKEN="$(openssl rand -hex 24)"
	else
		EXISTING_FLEET_TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
	fi
fi

# WiFi-reset secret for POST /api/wifi/reset — purges saved profiles and reboots
# into the captive setup portal, so a client whose WiFi password changed can be
# re-paired without a site visit.
#
# AUTO-GENERATED for the same reason as the fleet token, and this one was
# ACTUALLY BROKEN: install.sh never wrote AERO_WIFI_RESET_TOKEN at all, and the
# endpoint is fail-closed, so the self-recovery hatch returned 503 on every
# fielded Pi. The feature existed in code, was documented in its own docstring,
# and could not fire anywhere in the fleet.
#
# Distinct from the other two on purpose: this token reboots a device off the
# network, which is the most destructive remote action available, so it is not
# folded into AERO_ADMIN_TOKEN. Re-runs preserve an operator's own value.
if [[ -z "${EXISTING_WIFI_RESET_TOKEN}" ]]; then
	if [[ -n "${AERO_WIFI_RESET_TOKEN:-}" ]]; then
		EXISTING_WIFI_RESET_TOKEN="${AERO_WIFI_RESET_TOKEN}"
	elif command -v openssl >/dev/null 2>&1; then
		EXISTING_WIFI_RESET_TOKEN="$(openssl rand -hex 24)"
	else
		EXISTING_WIFI_RESET_TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
	fi
fi

# Cesium Ion token, served at RUNTIME by /api/internal/ion-token instead of
# being inlined into the client bundle at build time. Seeded, in order, from:
# an existing config.env value, the CESIUM_ION_TOKEN env of this run, or the
# .env this installer already manages. Keeping it here (not in .env) is what
# lets a device consume a CI-built, secret-free artifact.
if [[ -z "${EXISTING_ION_TOKEN}" ]]; then
	if [[ -n "${CESIUM_ION_TOKEN:-}" ]]; then
		EXISTING_ION_TOKEN="${CESIUM_ION_TOKEN}"
	elif [[ -r "${INSTALL_DIR}/.env" ]]; then
		EXISTING_ION_TOKEN="$(command grep -oP '^VITE_CESIUM_ION_TOKEN=\K.*' "${INSTALL_DIR}/.env" 2>/dev/null || true)"
	fi
fi

# Tile cache. api/tiles resolves TILE_DIR env → /opt/zyeta-aero/tiles →
# ./data/tiles — none of which is this install's dir, so leaving TILE_DIR unset
# turns every tile into a remote fetch on a box whose whole point is offline
# operation. data/ is gitignored, so the cache survives the updater's reset.
TILE_DIR_VALUE="${INSTALL_DIR}/data/tiles"
# Client-side base for the same cache. Overridable for an external tile host;
# the default is this app's own route, so no per-device host/port to maintain.
TILE_SERVER_URL_VALUE="${VITE_TILE_SERVER_URL:-/api/tiles}"
if [[ -d "${LEGACY_DIR}/data/tiles" && ! -d "${TILE_DIR_VALUE}" ]]; then
	echo "  migrating tile cache from ${LEGACY_DIR}/data/tiles (copy — original left intact)"
	install -d -m 755 -o "${PI_USER}" -g "${PI_USER}" "${INSTALL_DIR}/data"
	cp -a "${LEGACY_DIR}/data/tiles" "${TILE_DIR_VALUE}"
	chown -R "${PI_USER}:${PI_USER}" "${TILE_DIR_VALUE}"
fi

cat > /etc/aero/config.env <<EOF
# Managed by deploy/pi/install.sh — re-run install to regenerate.
AERO_ROLE=${AERO_ROLE}
AERO_GROUP=${AERO_GROUP}
AERO_INSTALL_DIR=${INSTALL_DIR}
AERO_USER=${PI_USER}
AERO_PORT=3000
AERO_ADMIN_URL=${EXISTING_ADMIN_URL}
AERO_ADMIN_TOKEN=${EXISTING_ADMIN_TOKEN}
AERO_FLEET_TOKEN=${EXISTING_FLEET_TOKEN}
AERO_WIFI_RESET_TOKEN=${EXISTING_WIFI_RESET_TOKEN}
AERO_BUN_BIN=${BUN_BIN}
AERO_BRANCH=release
AERO_APP_SUBDIR=${AERO_APP_SUBDIR}
TILE_DIR=${TILE_DIR_VALUE}
CESIUM_ION_TOKEN=${EXISTING_ION_TOKEN}
# Client-side base for the packaged tile cache. Vite inlines VITE_* at BUILD
# time, so this is read by aero-updater.sh's rebuild (which exports config.env
# via set -a), not at runtime. Relative on purpose — the app serves its own
# tiles from /api/tiles, so there is no host or port to get wrong per device.
# Safe to leave set even with an empty TILE_DIR: the client probes
# /api/tiles/health, which reports hasTiles, and falls back to the remote
# imagery/terrain hosts when the cache is empty.
VITE_TILE_SERVER_URL=${TILE_SERVER_URL_VALUE}
EOF
# 0640 root:${PI_USER} — this file now carries the admin bearer token, so it
# must not stay world-readable the way a pure-config file could.
chown "root:${PI_USER}" /etc/aero/config.env
chmod 640 /etc/aero/config.env

fi  # end !UNITS_ONLY (steps 1-5)

# ─── Step 5b: additive config.env keys (runs in BOTH modes) ──────────────────
# Keys the app grows AFTER a device was provisioned must still reach it via
# OTA: aero-updater.sh re-runs this installer with --units-only, which skips
# the full config.env write above (it would reset AERO_ROLE/GROUP — the
# updater passes no --role --group — and drop operator-added keys). Without
# this block, a Pi imaged before AERO_FLEET_TOKEN existed never gets one:
# POST /api/fleet/heartbeat is fail-closed and health-check.sh swallows curl
# errors, so the fleet health page stays silently empty forever.
#
# Append-only and idempotent: existing values (including a fleet-shared token
# hand-provisioned by the operator) are preserved; '=.' treats an empty value
# as missing. systemd EnvironmentFile last-wins, so appending is safe even if
# a duplicate somehow exists.
if [[ -f /etc/aero/config.env ]] && ! command grep -q '^AERO_FLEET_TOKEN=.' /etc/aero/config.env; then
	ADDED_FLEET_TOKEN=""
	if command -v openssl >/dev/null 2>&1; then
		ADDED_FLEET_TOKEN="$(openssl rand -hex 24)"
	else
		ADDED_FLEET_TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
	fi
	echo "AERO_FLEET_TOKEN=${ADDED_FLEET_TOKEN}" >> /etc/aero/config.env
	echo "  added missing AERO_FLEET_TOKEN to /etc/aero/config.env (generated)"
fi

# Media keys, same append-only treatment and for the same reason: media-store
# and usb-import read these from the environment, and a Pi imaged before they
# existed reaches this installer only through --units-only, which skips the
# config.env write above entirely.
#
# AERO_MEDIA_ORIGINS is seeded EMPTY here so the key exists in the file for an
# operator to fill. It is consumed at BUILD time (step 4 reads it back out of
# this file), not at runtime, so a value written here takes effect at the next
# OTA rebuild -- not on the next restart. When a wall points its panes at a
# peer via PUBLIC_WALL_ORIGIN, that peer must appear here too, or every
# cross-origin track is blocked with no error and no sound.
while IFS='=' read -r key value; do
	# Presence, not a non-empty value: an operator who blanked one of these
	# meant it, and AERO_MEDIA_ORIGINS is legitimately empty by default.
	if [[ -f /etc/aero/config.env ]] && ! command grep -q "^${key}=" /etc/aero/config.env; then
		echo "${key}=${value}" >> /etc/aero/config.env
		echo "  added missing ${key} to /etc/aero/config.env"
	fi
done <<EOF
AERO_MEDIA_DIR=${INSTALL_DIR}/data/media
AERO_MEDIA_MAX_MB=50
AERO_USB_DIR=/media/aero
AERO_MEDIA_ORIGINS=
PUBLIC_WALL_ORIGIN=
EOF

# ─── Step 6: Systemd units + cron jobs ────────────────────────────────────────

echo "[6/7] Installing systemd units + cron..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Copy units, rewriting placeholder paths for this install.
#
# __AERO_APP_DIR__ is distinct from __AERO_INSTALL_DIR__ because the repo now
# holds two applications (aero-1/, aero-2/) and shared assets at the root.
# INSTALL_DIR is where the GIT REPO is; APP_DIR is the directory that has a
# package.json and a build/. They were the same path for v1's whole life, and
# a unit that assumes they still are runs `bun run serve` somewhere with no
# package.json.
#
# Chosen once at the top of this script (--app, then config.env, then the
# fresh-install default), so re-running the installer on an already-fielded
# Pi keeps whichever app that Pi already runs.
# APP_DIR was resolved once, right after argument parsing (see there), so the
# build in step 4 and the units here cannot disagree about which app this is.
echo "  app directory: ${APP_DIR}"

for unit in aero-xserver.service aero-app.service aero-kiosk.service aero-updater.service aero-wifi-portal.service; do
	sed \
		-e "s|__AERO_USER__|${PI_USER}|g" \
		-e "s|__AERO_INSTALL_DIR__|${INSTALL_DIR}|g" \
		-e "s|__AERO_APP_DIR__|${APP_DIR}|g" \
		-e "s|__BUN_BIN__|${BUN_BIN}|g" \
		"${SCRIPT_DIR}/${unit}" > "/etc/systemd/system/${unit}"
	chmod 644 "/etc/systemd/system/${unit}"
done
# The updater timer has no placeholders — copy verbatim.
install -m 644 "${SCRIPT_DIR}/aero-updater.timer" /etc/systemd/system/aero-updater.timer

# Passwordless sudo for exactly the commands the app's privileged endpoints
# run (/api/update, /api/wifi/reset). Without this, `sudo -n` fails and — now
# that both endpoints preflight it — the operator gets a truthful 503 instead
# of a silent no-op. Validated with visudo before installing; a broken
# fragment can lock out sudo entirely, so a failed validation skips it.
sed "s|__AERO_USER__|${PI_USER}|g" "${SCRIPT_DIR}/aero.sudoers" > /etc/sudoers.d/aero.tmp
if visudo -cf /etc/sudoers.d/aero.tmp >/dev/null 2>&1; then
	install -m 440 /etc/sudoers.d/aero.tmp /etc/sudoers.d/aero
else
	echo "  WARN: sudoers fragment failed visudo validation — skipping (privileged endpoints will 503)"
fi
rm -f /etc/sudoers.d/aero.tmp

# Retire units from superseded layouts. The loop above only OVERWRITES units it
# still ships, so a unit that was dropped from the project survives a re-provision
# and keeps auto-starting forever. aero-fleet ran the standalone WebSocket broker
# deleted in Phase 9 (replaced by REST + SSE inside the app itself).
# aero-watchdog came from provision-pi.sh (removed 2026-07-28): a 5-minute timer
# that restarted aero-kiosk whenever it was inactive, duplicating the in-app
# liveness watchdog and racing it on a restart. aero-gpio-reset came from the
# pre-git layout and points at a script under /home/pi that no longer exists,
# so it fails on every boot and shows in `systemctl --failed`.
DEAD_UNITS=(aero-fleet.service aero-watchdog.timer aero-watchdog.service aero-gpio-reset.service)
for dead_unit in "${DEAD_UNITS[@]}"; do
	if [[ -f "/etc/systemd/system/${dead_unit}" ]]; then
		systemctl disable --now "${dead_unit}" >/dev/null 2>&1 || true
		rm -f "/etc/systemd/system/${dead_unit}"
		echo "  retired ${dead_unit} (superseded layout)"
	fi
done

# Helper scripts — installed to /usr/local/lib/aero so units have a stable path.
install -d -m 755 /usr/local/lib/aero
install -m 755 "${SCRIPT_DIR}/health-check.sh"        /usr/local/lib/aero/health-check.sh
install -m 755 "${SCRIPT_DIR}/display-dim-schedule.sh" /usr/local/lib/aero/display-dim-schedule.sh
install -m 755 "${SCRIPT_DIR}/aero-wifi-portal.sh"     /usr/local/lib/aero/aero-wifi-portal.sh

# Captive Wi-Fi setup portal (balena wifi-connect). Until this block existed
# the unit was never installed and the binary never downloaded, so
# POST /api/wifi/reset answered 503 on every fielded Pi (see lib/server/wifi.ts).
# Pinned release; skipped once present; and `|| WARN` because this runs under
# `set -e` on the --units-only OTA path — a venue that blocks GitHub must not
# abort the rest of the unit install. The endpoint keeps refusing the reset
# while the binary is missing, so a failed download degrades to "no portal",
# never to "portal assumed".
WIFI_CONNECT_VERSION="v4.11.84"
if [[ ! -x /usr/local/bin/wifi-connect || ! -d /usr/local/share/wifi-portal ]]; then
	case "$(dpkg --print-architecture 2>/dev/null || echo unknown)" in
		arm64) WC_ARCH="aarch64-unknown-linux-gnu" ;;
		armhf) WC_ARCH="armv7-unknown-linux-gnueabihf" ;;
		amd64) WC_ARCH="x86_64-unknown-linux-gnu" ;;
		*)     WC_ARCH="" ;;
	esac
	WC_BASE="https://github.com/balena-os/wifi-connect/releases/download/${WIFI_CONNECT_VERSION}"
	WC_TMP="$(mktemp -d)"
	if [[ -n "${WC_ARCH}" ]] \
		&& curl -fsSL "${WC_BASE}/wifi-connect-${WC_ARCH}.tar.gz" -o "${WC_TMP}/bin.tar.gz" \
		&& curl -fsSL "${WC_BASE}/wifi-connect-ui.tar.gz" -o "${WC_TMP}/ui.tar.gz" \
		&& tar -xzf "${WC_TMP}/bin.tar.gz" -C "${WC_TMP}" \
		&& install -m 755 "$(/usr/bin/find "${WC_TMP}" -type f -name wifi-connect | head -n 1)" /usr/local/bin/wifi-connect \
		&& rm -rf /usr/local/share/wifi-portal && install -d -m 755 /usr/local/share/wifi-portal \
		&& tar -xzf "${WC_TMP}/ui.tar.gz" -C /usr/local/share/wifi-portal \
		&& [[ -f /usr/local/share/wifi-portal/index.html ]]; then
		echo "  installed wifi-connect ${WIFI_CONNECT_VERSION} (${WC_ARCH}) + portal UI"
	else
		echo "  WARN: wifi-connect download/install failed — /api/wifi/reset will keep refusing (no portal to come back to)"
	fi
	rm -rf "${WC_TMP}"
fi

# Cron entries — written to /etc/cron.d so they're package-level, not user-level.
install -m 644 "${SCRIPT_DIR}/nightly-reboot.cron"       /etc/cron.d/aero-nightly-reboot
install -m 644 "${SCRIPT_DIR}/weekly-cache-clear.cron"   /etc/cron.d/aero-weekly-cache-clear

# Pen-drive automount. Pi OS Lite has no desktop, so nothing mounts a stick
# unless we do; /media/aero is what AERO_USB_DIR defaults to in the app.
# The reload+trigger matters: without it the rule sits on disk doing nothing
# until the next reboot, so an OTA that "installed pen-drive support" would
# leave every fielded Pi still ignoring a stick until someone power-cycled it.
# The mount point is whatever config.env says AERO_USB_DIR is (the app and the
# updater read the same key), so the rule is templated like the units rather
# than hardcoding a path an operator could then change to no effect.
USB_DIR_VALUE="$(command grep -oP '^AERO_USB_DIR=\K.*' /etc/aero/config.env 2>/dev/null || true)"
USB_DIR_VALUE="${USB_DIR_VALUE:-/media/aero}"
sed "s|__AERO_USB_DIR__|${USB_DIR_VALUE}|g" "${SCRIPT_DIR}/99-aero-usb.rules" > /etc/udev/rules.d/99-aero-usb.rules
chmod 644 /etc/udev/rules.d/99-aero-usb.rules
install -d -m 755 "${USB_DIR_VALUE}"
if command -v udevadm >/dev/null 2>&1; then
	udevadm control --reload-rules >/dev/null 2>&1 || true
	udevadm trigger --subsystem-match=block >/dev/null 2>&1 || true
fi

# Log rotation for the updater's append-only log (SD-card lifespan).
install -m 644 "${SCRIPT_DIR}/aero-updater.logrotate"    /etc/logrotate.d/aero-updater
# Health + display-dim entries we generate here (they parameterise on AERO_* vars).
cat > /etc/cron.d/aero-health-check <<EOF
# Every 60s — report fps/temp/uptime via POST. Silent failure is OK.
* * * * * ${PI_USER} /usr/local/lib/aero/health-check.sh >/dev/null 2>&1
EOF
chmod 644 /etc/cron.d/aero-health-check

cat > /etc/cron.d/aero-display-dim <<EOF
# 2 AM dim to 5%, 6 AM restore to 100%.
0 2 * * * root /usr/local/lib/aero/display-dim-schedule.sh dim
0 6 * * * root /usr/local/lib/aero/display-dim-schedule.sh bright
# Re-assert on boot. ddcutil brightness lives in the MONITOR's NVRAM, so 5%
# survives a power cycle — and the nightly reboot is at 04:00, inside the dim
# window. Without this a missed 06:00 run leaves the wall at 5% all day with
# nothing to recover it. Sleep lets X and the DDC bus come up before we poke.
@reboot root sleep 90 && /usr/local/lib/aero/display-dim-schedule.sh auto
EOF
chmod 644 /etc/cron.d/aero-display-dim

# ─── Boot branding — one held frame from power-on to live window ──────────────
#
# The Plymouth theme, the X root window and the app's BootLockup all use the
# SAME png, so the audience sees a single still image dissolve into the globe
# instead of: rainbow firmware splash -> four raspberry logos -> kernel scroll
# -> stock Plymouth -> black flash -> app. Suppressing those is the point.

if [[ -d "${SCRIPT_DIR}/branding" && "${UNITS_ONLY}" == false ]]; then
	echo "      + boot branding (Plymouth theme + quiet boot)"
	install -d -m 755 /usr/share/plymouth/themes/aero
	install -m 644 "${SCRIPT_DIR}/branding/aero.plymouth"   /usr/share/plymouth/themes/aero/aero.plymouth
	install -m 644 "${SCRIPT_DIR}/branding/aero.script"     /usr/share/plymouth/themes/aero/aero.script
	install -m 644 "${SCRIPT_DIR}/branding/aero-splash.png" /usr/share/plymouth/themes/aero/aero-splash.png
	# -R is load-bearing: it rebuilds the initramfs. config.txt sets
	# auto_initramfs=1, so early-boot Plymouth runs FROM the initramfs and
	# reads the theme out of it — setting the default without rebuilding
	# leaves the old image in place and the stock theme on screen, which is
	# precisely the "rainbow -> logos -> stock Plymouth" sequence this block
	# exists to remove. Verified broken on a fielded card (aero-display-00):
	# initramfs_2712 stamped 20:36, the branding installed at ~21:35 — an
	# hour later, so the theme was never in the image the Pi actually boots.
	# Fall back to a bare set + explicit rebuild if -R is unsupported.
	if ! plymouth-set-default-theme -R aero >/dev/null 2>&1; then
		plymouth-set-default-theme aero >/dev/null 2>&1 || true
		update-initramfs -u >/dev/null 2>&1 || true
	fi

	# Firmware rainbow splash off. Idempotent: only appended once.
	backup_boot_file /boot/firmware/config.txt
	if ! command grep -q "^disable_splash=1" /boot/firmware/config.txt 2>/dev/null; then
		printf '\n# Boot branding — suppress the firmware rainbow.\ndisable_splash=1\n' \
			>> /boot/firmware/config.txt
	fi

	# Raspberry logos, kernel scroll, console cursor off; hand over to Plymouth.
	# cmdline.txt MUST stay a single line — a stray newline makes everything
	# after it invisible to the kernel. So: slurp, dedupe, rewrite whole.
	if [[ -w /boot/firmware/cmdline.txt ]]; then
		backup_boot_file /boot/firmware/cmdline.txt
		CMDLINE="$(tr -d '\n' < /boot/firmware/cmdline.txt)"
		for tok in logo.nologo quiet loglevel=3 vt.global_cursor_default=0 splash plymouth.ignore-serial-consoles; do
			case " ${CMDLINE} " in
				*" ${tok} "*) ;;                       # already present
				*) CMDLINE="${CMDLINE} ${tok}" ;;
			esac
		done
		printf '%s\n' "${CMDLINE}" > /boot/firmware/cmdline.txt
	fi
fi

# ─── Step 7: Enable + start (idempotent — enable is a no-op on second run) ────

echo "[7/7] Enabling services..."
systemctl daemon-reload
# aero-wifi-portal is enable-only: it decides at boot whether a portal is
# needed and exits 0 when a network is up, so --now here would be a no-op.
systemctl enable aero-xserver.service aero-app.service aero-kiosk.service aero-wifi-portal.service
systemctl enable --now aero-updater.timer

# WiFi power-save off (idempotent write).
install -d -m 755 /etc/NetworkManager/conf.d
cat > /etc/NetworkManager/conf.d/aero-no-powersave.conf <<EOF
[connection]
wifi.powersave = 2
EOF

# Screen blanking off for the kiosk session (idempotent grep-guard).
if ! grep -q "consoleblank=0" /boot/firmware/cmdline.txt 2>/dev/null; then
	backup_boot_file /boot/firmware/cmdline.txt
	sed -i 's/$/ consoleblank=0/' /boot/firmware/cmdline.txt || true
fi

echo ""
echo "============================================"
echo "  Install complete"
echo "============================================"
if [[ -d "${LEGACY_DIR}" ]]; then
	# Migrating a Pi off the pre-git layout: its old kiosk unit owns tty1/:0 via
	# its own xinit, which this layout runs as a separate aero-xserver unit.
	# Starting the new units now would fight it for the display — reboot instead.
	echo "MIGRATION: a legacy install exists at ${LEGACY_DIR}."
	echo "           REBOOT to switch over — do NOT 'systemctl start' the units"
	echo "           now, the old kiosk still holds tty1/:0."
	echo ""
	echo "Reboot:      sudo reboot"
else
	echo "Start now:   sudo systemctl start aero-xserver aero-app aero-kiosk"
	echo "Reboot:      sudo reboot"
fi
echo "Logs (app):  journalctl -u aero-app -f"
echo "Logs (X):    journalctl -u aero-kiosk -f"
echo ""
echo "Role:        ${AERO_ROLE}   Group: ${AERO_GROUP}"
echo "URL:         http://localhost:3000/?role=${AERO_ROLE}&group=${AERO_GROUP}"
