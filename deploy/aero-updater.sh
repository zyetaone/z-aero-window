#!/usr/bin/env bash
# =============================================================================
# Zyeta Aero — OTA Updater
#
# Pulls CI-blessed code from git, installs dependencies, rebuilds, restarts
# services, and VERIFIES the app came back — rolling back to the previous
# commit on any failure (install, build, or post-restart health probe).
# Runs as a systemd timer (daily) or on-demand.
#
# Deploy gate: tracks the `release` branch by default, which CI fast-forwards
# ONLY after check + tests + build pass on main (.github/workflows/ci.yml).
# A red commit on main never reaches the fleet.
#
# Usage:
#   sudo bash aero-updater.sh              # Full update
#   sudo bash aero-updater.sh --check      # Check only, no restart
# =============================================================================

set -euo pipefail

# git refuses to run without HOME ("fatal: $HOME not set") and systemd units
# get a near-empty environment. The unit sets this too; kept here so a manual
# `sudo bash aero-updater.sh` and any future caller are equally safe.
export HOME="${HOME:-/root}"

# Source device config FIRST — it supplies AERO_INSTALL_DIR / AERO_PORT /
# AERO_BUN_BIN / AERO_BRANCH, so the layout is discovered, not hardcoded.
# This is what lets ONE updater serve both provisioning schemes.
if [[ -r /etc/aero/config.env ]]; then
    # `set -a` so every key is EXPORTED, not merely set in this shell. The
    # rebuild below is a child process, and Vite inlines VITE_* at compile
    # time — without the export, VITE_TILE_SERVER_URL never reaches it and
    # every on-device rebuild silently dropped the packaged tile cache,
    # sending a kiosk that has 2.7 GB of local tiles back to streaming from
    # the public internet.
    # Exporting the whole file is safe: Vite only inlines VITE_*-prefixed
    # names into the client bundle, so AERO_ADMIN_TOKEN / AERO_FLEET_TOKEN /
    # CESIUM_ION_TOKEN stay out of it (the Ion token is deliberately
    # unprefixed and served at runtime instead).
    set -a
    # shellcheck disable=SC1091
    source /etc/aero/config.env
    set +a
fi

INSTALL_DIR="${AERO_INSTALL_DIR:-/opt/zyeta-aero}"
LOG_FILE="/var/log/aero-updater.log"
BRANCH="${AERO_BRANCH:-release}"
BUN_BIN="${AERO_BUN_BIN:-/home/kiosk/.bun/bin/bun}"
APP_PORT="${AERO_PORT:-${PORT:-5173}}"
PROBE_URL="http://localhost:${APP_PORT}/api/status"

# The repo lives either directly at INSTALL_DIR (deploy/pi scheme) or under
# an /app subdir (provision-pi scheme). Detect by where .git actually is.
if [[ -d "${INSTALL_DIR}/.git" ]]; then
    REPO_DIR="${INSTALL_DIR}"
else
    REPO_DIR="${INSTALL_DIR}/app"
fi

# WHERE THE BUILDABLE APP LIVES, which is no longer the git root.
#
# The repo used to hold exactly one application at its top level, so git root
# and app root were the same directory and this script simply cd'd once. Then
# v1 moved into aero-1/ and the rewrite into aero-2/, and the root kept only
# shared assets (data/, tools/, deploy/) with no package.json at all. An
# updater that still built at the git root would run `bun install` in a
# directory with nothing to install, fail, and roll back — on every device, on
# every daily timer, forever.
#
# Resolved rather than hardcoded so one script serves a fleet mid-migration:
# an explicit AERO_APP_SUBDIR wins, then whichever candidate actually has a
# package.json, and finally the git root itself for a Pi still on the old
# single-app layout that has not been re-provisioned yet.
#
# A FUNCTION, not a one-shot assignment, because the layout is itself part of
# what an update changes. The commit that moves v1 into aero-1/ flips this
# answer, so a value resolved once at startup would be stale by the time the
# build runs — and stale in the specific direction that builds the old path.
# Every consumer below re-resolves after the working tree has settled, and
# rollback re-resolves again because reverting can flip it back.
resolve_app_dir() {
    if [[ -n "${AERO_APP_SUBDIR:-}" ]]; then
        APP_DIR="${REPO_DIR}/${AERO_APP_SUBDIR}"
    elif [[ -f "${REPO_DIR}/package.json" ]]; then
        APP_DIR="${REPO_DIR}"
    elif [[ -f "${REPO_DIR}/aero-1/package.json" ]]; then
        APP_DIR="${REPO_DIR}/aero-1"
    else
        APP_DIR="${REPO_DIR}"
    fi
}
resolve_app_dir

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG_FILE}"; }

CHECK_ONLY=false
if [[ "${1:-}" == "--check" ]]; then CHECK_ONLY=true; fi

log "=== Aero Updater starting (branch: ${BRANCH}) ==="

# ─── 1. Check for updates ────────────────────────────────────────────────

if [[ ! -d "${REPO_DIR}/.git" ]]; then
    log "No git repo at ${REPO_DIR} — skipping"
    exit 0
fi

cd "${REPO_DIR}"

if [[ ! -x "${BUN_BIN}" ]]; then
    log "ERROR: Bun runtime not found at ${BUN_BIN}"
    exit 1
fi

# The timer runs this as root but the repo is owned by the kiosk user; modern
# git refuses operations on other-owned repos ("dubious ownership") without
# this. Idempotent — only added once.
git config --global --get-all safe.directory 2>/dev/null | command grep -qxF "${REPO_DIR}" \
    || git config --global --add safe.directory "${REPO_DIR}"

# Explicit refspec: fielded Pis were provisioned with single-branch shallow
# clones whose default fetch refspec only covers their original branch — a
# plain `git fetch origin release` would never materialise the remote ref.
# Pen drive first. A stick mounted at /media/aero (99-aero-usb.rules) holding a
# `git bundle` of the release branch — `git bundle create aero-release.bundle
# release` on any laptop — updates a Pi with no network at all. Same build,
# probe and rollback pipeline below; only where the commits come from changes.
USB_DIR="${AERO_USB_DIR:-/media/aero}"
SOURCE="origin"
BUNDLE=$(ls -t "${USB_DIR}"/aero-release*.bundle 2>/dev/null | head -n 1 || true)
if [[ -n "${BUNDLE}" ]] && git bundle verify "${BUNDLE}" >/dev/null 2>&1; then
    log "Pen drive: fetching ${BRANCH} from ${BUNDLE}"
    if git fetch "${BUNDLE}" "+refs/heads/${BRANCH}:refs/remotes/usb/${BRANCH}" --quiet 2>&1 | tee -a "${LOG_FILE}"; then
        # A stick left in a Pi must not pin it to the build it carried: only a
        # bundle that is AHEAD of what runs is a source. Old or equal → network.
        if git merge-base --is-ancestor "usb/${BRANCH}" HEAD 2>/dev/null; then
            log "Pen drive: bundle is not newer than HEAD — ignoring it"
        else
            SOURCE="usb"
        fi
    else
        log "WARN: bundle fetch failed — falling back to the network"
    fi
fi

if [[ "${SOURCE}" == "origin" ]]; then
    git fetch origin "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" --quiet 2>&1 | tee -a "${LOG_FILE}" || {
        log "WARN: git fetch failed (no network, or '${BRANCH}' not published yet?) — skipping update"
        exit 0
    }
fi

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "${SOURCE}/${BRANCH}")

if [[ "${LOCAL}" == "${REMOTE}" ]]; then
    log "Already up to date (${LOCAL:0:8})"
    exit 0
fi

log "Update available: ${LOCAL:0:8} → ${REMOTE:0:8}"

if [[ "${CHECK_ONLY}" == true ]]; then
    log "Check-only mode — not applying"
    exit 0
fi

# ─── Helpers ─────────────────────────────────────────────────────────────

restart_services() {
    systemctl restart aero-app.service 2>/dev/null || true
    systemctl restart aero-kiosk.service 2>/dev/null || true
}

# Probe the app's own status endpoint. curl -f treats server.ts's
# "no build found" 503 as failure, so a half-written build/ can't pass.
# 12 × 5s = up to 60s for Bun + SvelteKit handler to come up.
probe_health() {
    local i
    for ((i = 1; i <= 12; i++)); do
        if curl -fsS --max-time 3 "${PROBE_URL}" >/dev/null 2>&1; then
            return 0
        fi
        sleep 5
    done
    return 1
}

# Snapshot / restore the last known-good build.
#
# `bun run build` DESTROYS build/ before it writes: @sveltejs/adapter-node
# calls `builder.rimraf(out)` as its first act (verified against 5.5.7,
# index.js line 32). So the old rollback log line — "previous build/ still on
# disk" — was false. A failed rollback build left the device with NO build at
# all, which server.ts answers with exit 1, which under Restart=always is a
# crash loop with nothing to recover to.
#
# 34 MB for v1, 5.7 MB for aero-2. Cheap insurance.
snapshot_build() {
    [[ -d "${APP_DIR}/build" ]] || return 0
    rm -rf "${APP_DIR}/build.prev"
    cp -a "${APP_DIR}/build" "${APP_DIR}/build.prev" 2>/dev/null \
        || log "WARN: could not snapshot build/ — rollback will have no fallback"
}

restore_build() {
    [[ -d "${APP_DIR}/build.prev" ]] || return 1
    rm -rf "${APP_DIR}/build"
    cp -a "${APP_DIR}/build.prev" "${APP_DIR}/build"
}

# Full rollback: previous commit + reinstall + rebuild + restart + verify.
# Wired to EVERY failure class (install, build, post-restart probe) — the
# old build-only rollback let a builds-fine-crashes-at-runtime commit ship,
# and a double install failure left HEAD updated with a stale build
# ("already up to date" on the next run while broken).
rollback() {
    log "ERROR: $1 — rolling back to ${LOCAL:0:8}"
    git reset --hard "${LOCAL}" 2>&1 | tee -a "${LOG_FILE}"
    # The revert may have moved the app back to the git root, so ask again
    # rather than trusting the answer from before the reset.
    resolve_app_dir
    ( cd "${APP_DIR}" && "${BUN_BIN}" install --frozen-lockfile ) 2>&1 | tee -a "${LOG_FILE}" || true
    if ! ( cd "${APP_DIR}" && "${BUN_BIN}" run build ) 2>&1 | tee -a "${LOG_FILE}"; then
        if restore_build; then
            log "WARN: rollback build failed — restored the pre-update build/"
        else
            log "CRITICAL: rollback build failed and no build.prev to restore — device has no build/"
        fi
    fi
    restart_services
    if probe_health; then
        log "Rollback verified — serving ${LOCAL:0:8}"
    else
        log "CRITICAL: health probe failed even after rollback — operator attention needed"
    fi
    exit 1
}

# ─── 2. Pull changes ─────────────────────────────────────────────────────

log "Pulling changes..."
git reset --hard "${SOURCE}/${BRANCH}" 2>&1 | tee -a "${LOG_FILE}"
log "Updated to $(git rev-parse --short HEAD): $(git log -1 --format='%s')"

# The pull is what can relocate the app (the aero-1/ split is one such commit),
# so the layout question has to be re-asked against the tree we just landed.
resolve_app_dir
log "App directory: ${APP_DIR}"

# ─── 3. Install dependencies ─────────────────────────────────────────────

# Refuse to start on a nearly-full card.
#
# Nothing in this pipeline checked free space, and this device is unusually
# good at running out of it: a ~4 GB tile pack, a 2 GB Chromium disk cache that
# grows to its cap, node_modules, and `snapshot_build` deliberately keeping a
# SECOND copy of build/ for rollback. On a 16 GB card that is most of it.
#
# The failure mode is what makes this worth a guard rather than a log line.
# `bun install` and `vite build` on a full disk fail PARTWAY: adapter-node has
# already rimraf'd build/ before it writes, so a truncated build leaves the
# device with no servable output. That triggers rollback — which also builds,
# on the same full disk, and fails the same way. The rollback path cannot
# recover from the condition that caused it, so the kiosk goes dark and stays
# dark until someone drives to the site.
#
# Checking first turns an unrecoverable state into a skipped update: the device
# keeps serving the build it already has, and says why in the log and to the
# fleet.
MIN_FREE_MB="${AERO_MIN_FREE_MB:-1500}"
free_mb=$(df -Pm "${APP_DIR}" | awk 'NR==2 {print $4}')
if [[ -n "${free_mb}" ]] && (( free_mb < MIN_FREE_MB )); then
    log "SKIP: only ${free_mb} MB free at ${APP_DIR}, need ${MIN_FREE_MB} MB."
    log "      A build that runs out of disk deletes build/ before it fails, and"
    log "      the rollback build would hit the same wall — so the safe move is"
    log "      to keep serving ${LOCAL:0:8} and let an operator reclaim space."
    log "      Biggest consumers are usually the Chromium cache and data/tiles."
    exit 0
fi

snapshot_build

log "Installing dependencies..."
( cd "${APP_DIR}" && "${BUN_BIN}" install --frozen-lockfile ) 2>&1 | tee -a "${LOG_FILE}" || {
    log "WARN: bun install failed — trying without frozen lockfile"
    ( cd "${APP_DIR}" && "${BUN_BIN}" install ) 2>&1 | tee -a "${LOG_FILE}" || rollback "bun install failed"
}

# ─── 4. Build ────────────────────────────────────────────────────────────

if [[ -f "${APP_DIR}/package.json" ]] && command grep -q '"build"' "${APP_DIR}/package.json"; then
    log "Building app..."
    ( cd "${APP_DIR}" && "${BUN_BIN}" run build ) 2>&1 | tee -a "${LOG_FILE}" || rollback "build failed"
fi

# ─── 4b. Reinstall deploy config when it changed ─────────────────────────
# Until this existed the CD pipeline shipped CODE but not CONFIGURATION: a
# release could change deploy/pi/aero-kiosk.service, land on every Pi, and
# change nothing — because /etc/systemd/system/ is only ever written by
# install.sh. That is exactly how the ANGLE→EGL fix (7.5x framerate) reached
# the fleet and left it running the old flags at 2 fps.
#
# Scoped to --units-only on purpose: units + helper scripts + cron, never apt,
# never the build, never config.env (would clobber hand-set tokens), never the
# cmdline.txt / config.txt rewrites. Runs BEFORE restart_services so the restart
# picks up the new unit definitions rather than needing a second pass.
#
# Non-fatal: a failure here leaves the previous units in place and the new code
# still starts. That is degraded, not broken — and far better than rolling back
# a good build because a cron file could not be written.
INSTALLER="${REPO_DIR}/deploy/pi/install.sh"
if ! git diff --quiet "${LOCAL}" "${REMOTE}" -- deploy/ 2>/dev/null; then
    if [[ -f "${INSTALLER}" ]]; then
        log "deploy/ changed in this release — reinstalling units + cron"
        bash "${INSTALLER}" --units-only 2>&1 | tee -a "${LOG_FILE}" \
            || log "WARN: unit reinstall failed — keeping previous units"
    fi
else
    log "deploy/ unchanged — units left as-is"
fi

# ─── 5. Restart + verify ─────────────────────────────────────────────────

log "Restarting services..."
restart_services

log "Probing ${PROBE_URL} ..."
probe_health || rollback "health probe failed after restart"

log "=== Update complete — serving $(git rev-parse --short HEAD) ==="

# ─── 6. Self-refresh the installed copy ──────────────────────────────────
# provision-pi.sh installs a COPY of this script outside the repo; a git
# pull updates the repo copy but the timer keeps running the stale one.
# After a verified-green update, sync the installed copy.

INSTALLED_COPY="${INSTALL_DIR}/aero-updater.sh"
REPO_COPY="${REPO_DIR}/deploy/aero-updater.sh"
if [[ -f "${REPO_COPY}" && -f "${INSTALLED_COPY}" ]] \
    && ! cmp -s "${REPO_COPY}" "${INSTALLED_COPY}"; then
    install -m 755 "${REPO_COPY}" "${INSTALLED_COPY}"
    log "Self-refreshed installed updater copy from repo"
fi
