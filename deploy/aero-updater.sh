#!/usr/bin/env bash
# =============================================================================
# Zyeta Aero — OTA Updater
#
# Pulls latest code from git, installs dependencies, rebuilds if needed,
# and restarts services. Runs as a systemd timer (daily) or on-demand.
#
# Usage:
#   sudo bash aero-updater.sh              # Full update
#   sudo bash aero-updater.sh --check      # Check only, no restart
# =============================================================================

set -euo pipefail

INSTALL_DIR="/opt/zyeta-aero"
REPO_DIR="${INSTALL_DIR}/app"
LOG_FILE="/var/log/aero-updater.log"
BRANCH="${AERO_BRANCH:-main}"
FLEET_SERVER="${AERO_FLEET_SERVER:-}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG_FILE}"; }

CHECK_ONLY=false
if [[ "${1:-}" == "--check" ]]; then CHECK_ONLY=true; fi

log "=== Aero Updater starting ==="

# ─── 1. Check for updates ────────────────────────────────────────────────

if [[ ! -d "${REPO_DIR}/.git" ]]; then
    log "No git repo at ${REPO_DIR} — skipping"
    exit 0
fi

cd "${REPO_DIR}"

# Fetch without merging
git fetch origin "${BRANCH}" --quiet 2>&1 | tee -a "${LOG_FILE}" || {
    log "WARN: git fetch failed (no network?) — skipping update"
    exit 0
}

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/${BRANCH}")

if [[ "${LOCAL}" == "${REMOTE}" ]]; then
    log "Already up to date (${LOCAL:0:8})"
    exit 0
fi

log "Update available: ${LOCAL:0:8} → ${REMOTE:0:8}"

if [[ "${CHECK_ONLY}" == true ]]; then
    log "Check-only mode — not applying"
    exit 0
fi

# ─── 2. Pull changes ─────────────────────────────────────────────────────

log "Pulling changes..."
git reset --hard "origin/${BRANCH}" 2>&1 | tee -a "${LOG_FILE}"
log "Updated to $(git rev-parse --short HEAD): $(git log -1 --format='%s')"

# ─── 3. Install dependencies ─────────────────────────────────────────────

log "Installing dependencies..."
if command -v bun &>/dev/null; then
    bun install --frozen-lockfile 2>&1 | tee -a "${LOG_FILE}" || {
        log "WARN: bun install failed — trying without frozen lockfile"
        bun install 2>&1 | tee -a "${LOG_FILE}"
    }
fi

# ─── 4. Build (if display package has a build script) ─────────────────────

if [[ -f "packages/display/package.json" ]]; then
    log "Building display..."
    bun run build 2>&1 | tee -a "${LOG_FILE}" || {
        log "ERROR: Build failed — rolling back"
        git reset --hard "${LOCAL}" 2>&1 | tee -a "${LOG_FILE}"
        exit 1
    }
fi

# ─── 5. Restart services ─────────────────────────────────────────────────

log "Restarting services..."
systemctl restart aero-tiles.service 2>/dev/null || true
systemctl restart aero-display.service 2>/dev/null || true

log "=== Update complete ==="

# ─── 6. Report to fleet server (if configured) ───────────────────────────

if [[ -n "${FLEET_SERVER}" ]]; then
    DEVICE_NAME=$(hostname)
    VERSION=$(git rev-parse --short HEAD)
    curl -s -X POST "http://${FLEET_SERVER}:3001/api/health" \
        -H "Content-Type: application/json" \
        -d "{\"event\":\"updated\",\"device\":\"${DEVICE_NAME}\",\"version\":\"${VERSION}\"}" \
        2>/dev/null || true
    log "Reported update to fleet server"
fi
