#!/usr/bin/env bash
# =============================================================================
# Zyeta Aero — OTA Updater
#
# Pulls CI-blessed code from git, installs dependencies, rebuilds, restarts
# services, and VERIFIES the app came back — rolling back to the previous
# commit on any failure (install, build, or post-restart health probe).
# Runs as a systemd timer (every 15 min) or on-demand. Restarts are held to
# a wall-wide quarter-hour boundary so the three panes switch builds together.
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

# bun runs as the service user, never root. This unit has no User=, so
# `bun install` / `bun run build` used to leave node_modules/, .svelte-kit/,
# build/ and build.prev/ root-owned; the next full `install.sh` re-provision
# (which builds as the user) then died on EACCES at vite's rimraf of build/.
as_app_user() {
    if [[ -n "${AERO_USER:-}" && "${EUID}" -eq 0 ]]; then
        sudo -u "${AERO_USER}" -H "$@"
    else
        "$@"
    fi
}
# Hand the user anything an earlier root-run updater left behind.
reown_app_tree() {
    [[ -n "${AERO_USER:-}" && "${EUID}" -eq 0 ]] || return 0
    local d
    for d in node_modules .svelte-kit build build.prev; do
        [[ -e "${APP_DIR}/${d}" ]] && chown -R "${AERO_USER}:${AERO_USER}" "${APP_DIR}/${d}" 2>/dev/null || true
    done
}

# A release that rolled back is not retried every 15 minutes forever: the
# poisoned sha is appended here on every rollback and skipped once it has
# rolled back twice, so a bad release costs two builds per pane, not one per poll.
BAD_RELEASE_FILE="/var/lib/aero/bad-release"

# Floor of free disk required before any install/build. Defined before the
# repair branch so both paths — the stuck-state repair and the update path —
# share the same guard.
MIN_FREE_MB="${AERO_MIN_FREE_MB:-1500}"

CHECK_ONLY=false
if [[ "${1:-}" == "--check" ]]; then CHECK_ONLY=true; fi

log "=== Aero Updater starting (branch: ${BRANCH}) ==="

# ─── Helpers ─────────────────────────────────────────────────────────────

# The wall-wide apply boundary for a release, as a unix second.
#
# Three panes poll independently (15 min + 90 s jitter) and used to restart
# the moment each one finished building, so every push opened a window of
# up to ~16 minutes in which the wall ran two builds side by side. No
# coordination protocol is needed to close it: every pane computes the same
# boundary from the same two numbers — the release commit's committer time,
# which git carries to all of them, and the clock they already share.
#
# boundary = first quarter-hour at or after (commit time + lead). The lead
# covers the slowest poll (16.5 min) plus a build (~3 min) so that, in the
# normal case, every pane has fetched and built BEFORE the boundary and they
# restart within seconds of each other. A pane that finishes late restarts
# at once — a straggler, which is no worse than today. Pure function of its
# arguments, so it is unit-tested from aero-1/tests/tools.
apply_boundary() {
    local commit_ts="$1" lead="${2:-1200}" period=900
    echo $(( ( (commit_ts + lead + period - 1) / period ) * period ))
}

# How long to hold, and what to do instead. PURE: arguments in, one token out,
# no clock, no filesystem, no globals. Extracted beside apply_boundary for the
# same reason that one is: the hold decides whether the fleet stays in sync or
# one pane restarts early, and it is all arithmetic that can be pinned without
# running the updater on a Pi.
#
# Prints one of:
#   hold:<seconds>  boundary is ahead and inside the budget — sleep
#   now             boundary already passed — restart (a normal straggler)
#   overbudget      further out than the budget — restart, and the caller logs
#                   the skew, because over-budget is only reachable via a clock
#                   BEHIND the commit's
#
# The asymmetry matters: `now` is ordinary and expected (one pane built late),
# while `overbudget` means this pane's clock disagrees with the commit's, and
# unclamped it would sleep for months and never update again.
#
# The lead is a parameter rather than hardcoded so the caller and the test use
# the SAME number; a hardcoded 1200 here would silently disagree with
# AERO_APPLY_LEAD_SEC the day anyone changed it.
hold_decision() {
    local commit_ts="$1" now_ts="$2" lead="$3" budget="$4"
    local apply_at hold_sec
    apply_at=$(apply_boundary "${commit_ts}" "${lead}")
    hold_sec=$(( apply_at - now_ts ))
    if (( hold_sec <= 0 )); then
        echo "now"
    elif (( hold_sec > budget )); then
        echo "overbudget"
    else
        echo "hold:${hold_sec}"
    fi
}

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

# ─── Prebuilt releases ───────────────────────────────────────────────────
# CI attaches build/ + production node_modules to a `build-<sha>` release for
# every promoted commit (deploy/package-build.sh). Installing that replaces the
# on-device `bun install` of the whole dev tree and a >6 min `vite build` — the
# two steps that need the network and that a reboot can kill halfway.
#
# Any doubt returns 1 and the caller builds on-device exactly as before, so a
# missing release, a dead network or an odd device is never worse than today.
# Integrity, not authorship: the checksum comes from the same GitHub-over-HTTPS
# trust as the git fetch itself (and a stick's from the same physical access as
# its bundle). AERO_PREBUILT_BASE=off disables the whole path.
PREBUILT_BASE="${AERO_PREBUILT_BASE:-https://github.com/zyetaone/z-aero-window/releases/download}"

# What a local build would see for $1: the exported env (config.env is sourced
# with set -a) wins, as it does for Vite, then the app's .env file.
# ponytail: only .env — install.sh writes no .env.production/.env.local.
build_input() {
    local k="$1"
    if [[ -n "${!k+x}" ]]; then printf '%s' "${!k}"; return; fi
    command grep -m1 "^${k}=" "${APP_DIR}/.env" 2>/dev/null | cut -d= -f2- || true
}

# The prebuilt is valid only if every value CI compiled in is what this device
# would compile in, and the device sets no VITE_* that CI never saw.
prebuilt_inputs_match() {
    local manifest="$1" line key
    while IFS= read -r line || [[ -n "${line}" ]]; do
        key="${line%%=*}"
        if [[ "$(build_input "${key}")" != "${line#*=}" ]]; then
            log "Prebuilt: build input ${key} differs on this device"
            return 1
        fi
    done < "${manifest}"
    for key in $(compgen -e | command grep '^VITE_' || true) \
               $(command grep -o '^VITE_[A-Za-z0-9_]*' "${APP_DIR}/.env" 2>/dev/null || true); do
        if ! command grep -q "^${key}=" "${manifest}" && [[ -n "$(build_input "${key}")" ]]; then
            log "Prebuilt: this device sets ${key}, which the CI build never saw"
            return 1
        fi
    done
}

# Install the CI build for commit $1 into APP_DIR. Pen drive first
# (USB_DIR/prebuilt/build-<sha>/), then the GitHub release.
use_prebuilt() {
    local sha="$1" app stage src want got
    app="$(basename "${APP_DIR}")"
    [[ "${PREBUILT_BASE}" != "off" ]] || return 1
    [[ "${app}" == "aero-1" || "${app}" == "aero-2" ]] || return 1
    stage="${REPO_DIR}/.prebuilt"
    rm -rf "${stage}" && mkdir -p "${stage}" || return 1

    src="${USB_DIR:-/media/aero}/prebuilt/build-${sha}/${app}.tar.gz"
    if [[ -f "${src}" && -f "${src}.sha256" ]]; then
        cp "${src}" "${stage}/a.tgz" && cp "${src}.sha256" "${stage}/a.sha256" || { rm -rf "${stage}"; return 1; }
        log "Prebuilt: using ${src}"
    elif ! { curl -fsSL --retry 2 --connect-timeout 10 --max-time 900 -o "${stage}/a.tgz" "${PREBUILT_BASE}/build-${sha}/${app}.tar.gz" \
          && curl -fsSL --retry 2 --connect-timeout 10 --max-time 60 -o "${stage}/a.sha256" "${PREBUILT_BASE}/build-${sha}/${app}.tar.gz.sha256"; } 2>>"${LOG_FILE}"; then
        log "Prebuilt: none for ${sha:0:8} — building on-device"
        rm -rf "${stage}"; return 1
    fi

    want="$(awk '{print $1}' "${stage}/a.sha256")"
    got="$(sha256sum "${stage}/a.tgz" | awk '{print $1}')"
    if [[ -z "${want}" || "${want}" != "${got}" ]]; then
        log "WARN: prebuilt checksum mismatch for ${sha:0:8} — building on-device"
        rm -rf "${stage}"; return 1
    fi
    if ! tar xzf "${stage}/a.tgz" -C "${stage}" 2>>"${LOG_FILE}" \
        || [[ "$(cat "${stage}/COMMIT" 2>/dev/null)" != "${sha}" ]] \
        || [[ ! -f "${stage}/build/index.js" || ! -d "${stage}/node_modules" ]]; then
        log "WARN: prebuilt for ${sha:0:8} is incomplete — building on-device"
        rm -rf "${stage}"; return 1
    fi
    if ! prebuilt_inputs_match "${stage}/build-inputs.env"; then
        log "Prebuilt: building on-device so this device's settings are compiled in"
        rm -rf "${stage}"; return 1
    fi

    # The swap. A kill between the rm and the mv leaves no build/, which the
    # next poll's repair path restores from build.prev (snapshotted before this).
    rm -rf "${APP_DIR}/build" "${APP_DIR}/node_modules"
    mv "${stage}/build" "${APP_DIR}/build" && mv "${stage}/node_modules" "${APP_DIR}/node_modules" || {
        rm -rf "${stage}"; return 1
    }
    # The `$lib` alias aero-1's server.ts resolves through; normally written by
    # `bun install`'s prepare step, which this path skips.
    if [[ -f "${stage}/.svelte-kit/tsconfig.json" ]]; then
        mkdir -p "${APP_DIR}/.svelte-kit" && cp "${stage}/.svelte-kit/tsconfig.json" "${APP_DIR}/.svelte-kit/tsconfig.json"
    fi
    rm -rf "${stage}"
    reown_app_tree
    log "Prebuilt: installed the CI build of ${sha:0:8} (no on-device install or build)"
}

# Full rollback: previous commit + reinstall + rebuild + restart + verify.
# Wired to EVERY failure class (install, build, post-restart probe) — the
# old build-only rollback let a builds-fine-crashes-at-runtime commit ship,
# and a double install failure left HEAD updated with a stale build
# ("already up to date" on the next run while broken).
rollback() {
    log "ERROR: $1 — rolling back to ${LOCAL:0:8}"
    mkdir -p "$(dirname "${BAD_RELEASE_FILE}")" && echo "${REMOTE}" >> "${BAD_RELEASE_FILE}"
    git reset --hard "${LOCAL}" 2>&1 | tee -a "${LOG_FILE}"
    # The revert may have moved the app back to the git root, so ask again
    # rather than trusting the answer from before the reset.
    resolve_app_dir
    reown_app_tree
    if use_prebuilt "${LOCAL}"; then
        :
    elif ! { ( cd "${APP_DIR}" && as_app_user "${BUN_BIN}" install --frozen-lockfile ) 2>&1 | tee -a "${LOG_FILE}" || true
             ( cd "${APP_DIR}" && as_app_user "${BUN_BIN}" run build ) 2>&1 | tee -a "${LOG_FILE}"; }; then
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

# Restore HEAD to LOCAL after a pre-build skip, so the skipped release is
# retried on the next poll instead of consumed.
#
# Shared by the two pre-build guards (free-disk, runtime floor), which both run
# AFTER `git reset --hard` has already moved HEAD to REMOTE. Leaving HEAD there
# means is_newer is false on every later poll and the device never retries the
# release — even after the operator frees the disk or upgrades Bun, the log
# says "nothing to apply" forever. The restore makes "skip" mean the same thing
# in both places: retried next poll until the condition clears.
#
# Failing the restore is CRITICAL, not WARN: the update has been consumed and
# nothing else will re-trigger it, which is exactly the harm the guards exist
# to prevent. The device is still serving, so this still exits 0 — but the log
# word has to match every other "a safety property failed, a human is needed"
# case in this file, and WARN is that file's tier for self-correcting trouble.
restore_head_after_skip() {
    if [[ "$(git rev-parse HEAD)" == "${REMOTE}" ]]; then
        git reset --hard "${LOCAL}" >/dev/null 2>&1 \
            && log "      HEAD restored to ${LOCAL:0:8}; re-checked on every poll until then." \
            || log "      CRITICAL: could not restore HEAD to ${LOCAL:0:8} — the next poll may not retry."
    fi
}

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
# Trust model, accepted 2026-09-27: `git bundle verify` proves the bundle is
# well-formed, NOT who made it. Anyone with physical access to a Pi's USB port
# can hand it a bundle that is newer than HEAD and it will be built and run
# (then probed and rolled back only if it fails to serve). That is the same
# person who can pull the SD card, so the stick adds no privilege the port
# does not already grant. If the fleet ever leaves a locked cabinet, the
# upgrade path is a signed tag on the release branch and
# `git verify-tag` here before is_newer.
# $1 strictly later committer time than $2. Equal seconds → not newer, so two
# builds in one second never flip-flop; the next real release is later anyway.
is_newer() {
    local a b
    a=$(git log -1 --format=%ct "$1" 2>/dev/null || echo 0)
    b=$(git log -1 --format=%ct "$2" 2>/dev/null || echo 0)
    [[ "${a}" -gt "${b}" ]]
}
SOURCE="origin"
BUNDLE=$(ls -t "${USB_DIR}"/aero-release*.bundle 2>/dev/null | head -n 1 || true)
if [[ -n "${BUNDLE}" ]] && git bundle verify "${BUNDLE}" >/dev/null 2>&1; then
    log "Pen drive: fetching ${BRANCH} from ${BUNDLE}"
    if git fetch "${BUNDLE}" "+refs/heads/${BRANCH}:refs/remotes/usb/${BRANCH}" --quiet 2>&1 | tee -a "${LOG_FILE}"; then
        # A stick left in a Pi must not pin it to the build it carried: only a
        # bundle that is AHEAD of what runs is a source. Old or equal → network.
        # Committer time, NOT `merge-base --is-ancestor`: install.sh clones
        # --depth 20, and a bundle older than that boundary is not reachable
        # from HEAD at all, so ancestry called a months-old stick "new" and
        # would have downgraded the Pi. release is CI fast-forward-only, so a
        # later committer date is a later release.
        if is_newer "usb/${BRANCH}" HEAD; then
            SOURCE="usb"
        else
            log "Pen drive: bundle is not newer than HEAD — ignoring it"
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
    # THE STUCK STATE this used to hide: an update killed between adapter-node's
    # rimraf of build/ and the end of `vite build` (04:00 reboot, power cut,
    # TimeoutStartSec) leaves HEAD already at the tip with no build/. Every
    # later poll landed here, said "up to date", and the pane stayed dark —
    # aero-app's ConditionPathExists skips it and nothing ever rebuilt.
    if [[ ! -f "${APP_DIR}/build/index.js" ]]; then
        log "HEAD is current but ${APP_DIR}/build/index.js is MISSING — repairing"
        # The same guard as the update path. A full disk is what killed the
        # build mid-write in the first place, so rebuilding here fails the
        # same way — and `cp -a`-ing build.prev on a full disk can corrupt
        # the very fallback this branch exists to use. Stay degraded, say why.
        repair_free_mb=$(df -Pm "${APP_DIR}" | awk 'NR==2 {print $4}')
        if [[ -n "${repair_free_mb}" ]] && (( repair_free_mb < MIN_FREE_MB )); then
            log "CRITICAL: build/ missing and only ${repair_free_mb} MB free (need ${MIN_FREE_MB}) —"
            log "      not rebuilding: it would fail the same way and could corrupt build.prev."
            log "      Free space on this card; the next poll repairs for real."
            exit 0
        fi
        if restore_build; then
            log "Restored build.prev; rebuilding for the current commit"
        fi
        reown_app_tree
        if use_prebuilt "${LOCAL}"; then
            log "Repaired from the prebuilt ${LOCAL:0:8}"
        elif { ( cd "${APP_DIR}" && as_app_user "${BUN_BIN}" install --frozen-lockfile ) 2>&1 | tee -a "${LOG_FILE}" || true
               ( cd "${APP_DIR}" && as_app_user "${BUN_BIN}" run build ) 2>&1 | tee -a "${LOG_FILE}"; }; then
            log "Rebuilt ${LOCAL:0:8}"
        elif restore_build; then
            log "WARN: rebuild failed — serving the restored build.prev"
        else
            log "CRITICAL: rebuild failed and no build.prev — device still has no build/"
        fi
        restart_services
        probe_health && log "Repaired — serving ${LOCAL:0:8}" || log "CRITICAL: health probe failed after repair"
        exit 0
    fi
    log "Already up to date (${LOCAL:0:8})"
    exit 0
fi

# Two strikes, not one: rollback() also fires on a transient `bun install`
# failure (a network blip), and one of those must not ban a release until the
# next one lands. The second rollback of the same sha does.
if [[ -f "${BAD_RELEASE_FILE}" ]] && (( $(command grep -cxF "${REMOTE}" "${BAD_RELEASE_FILE}" 2>/dev/null || echo 0) >= 2 )); then
    log "Skipping ${REMOTE:0:8}: it rolled back twice on this pane (${BAD_RELEASE_FILE}); waiting for a newer release"
    exit 0
fi

# Forward only, from EITHER source. A pen drive can carry a release commit
# that origin does not have yet; without this, the next network run would
# "update" back to the older origin tip, the run after that would take the
# stick again, and the Pi would rebuild and restart every 15 minutes forever.
# release is CI fast-forward-only, so "remote is behind HEAD" is never a
# legitimate update — it is a stale source.
if ! is_newer "${REMOTE}" "${LOCAL}"; then
    log "${SOURCE}/${BRANCH} (${REMOTE:0:8}) is behind HEAD (${LOCAL:0:8}) — nothing to apply"
    exit 0
fi

log "Update available: ${LOCAL:0:8} → ${REMOTE:0:8}"

if [[ "${CHECK_ONLY}" == true ]]; then
    log "Check-only mode — not applying"
    exit 0
fi

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
free_mb=$(df -Pm "${APP_DIR}" | awk 'NR==2 {print $4}')
if [[ -n "${free_mb}" ]] && (( free_mb < MIN_FREE_MB )); then
    log "SKIP: only ${free_mb} MB free at ${APP_DIR}, need ${MIN_FREE_MB} MB."
    log "      A build that runs out of disk deletes build/ before it fails, and"
    log "      the rollback build would hit the same wall — so the safe move is"
    log "      to keep serving ${LOCAL:0:8} and let an operator reclaim space."
    log "      Biggest consumers are usually the Chromium cache and data/tiles."
    # HEAD was already moved to REMOTE by the reset above; restore it so this
    # release is retried on the next poll once space is reclaimed, rather than
    # consumed and never tried again (see restore_head_after_skip).
    restore_head_after_skip
    exit 0
fi

# ─── 3b. Runtime floor, read from the app being built ────────────────────────

# True when $1 (a version) is at or above $2 (a floor).
#
# `sort -V` is the whole comparison — hand-rolled numeric parsing gets 1.10
# wrong, and a floor check that calls 1.10 older than 1.9 is exactly the class
# of defect this guard exists to prevent. Deliberately a named function rather
# than an inline test: apply_boundary and hold_decision are covered from
# aero-1/tests/tools by extracting them from this file, and this sits next to
# them for the same reason. Its input is its only dependency, so the extractor
# can run it in a bare shell.
#
# Returns non-zero for a version that is not comparable at all (a failed
# `--version` reporting "unavailable"), because failing open would let an
# unusable runtime past a guard whose job is to notice exactly that.
bun_meets_floor() {
    # Fails CLOSED on a version it cannot parse. This is not defensive padding:
    # `printf '%s\n%s\n' 1.4.0 unavailable | sort -V` puts 1.4.0 first because
    # sort orders digits before letters, so without this guard a runtime that
    # cannot even answer `--version` would be measured as being ABOVE the floor
    # and waved through.
    #
    # The regex is ANCHORED, not the old prefix form: the prefix form accepted
    # `1.4.0junk`, whose trailing garbage sorts above `1.4.0` and so waved a
    # nonsense string through. The anchored form still admits a prerelease or
    # build suffix (`1.4.2-canary.1`, `1.4.0+build.1`) — having a suffix must
    # not, by itself, block a runtime.
    [[ "$1" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?([-+][0-9A-Za-z.-]+)?$ ]] || return 1
    # `sort -V` orders `1.4.0` BEFORE `1.4.0-beta` — the empty suffix sorts
    # first — so the compare below would call a prerelease of the floor "at or
    # above" it, while semver puts a prerelease BELOW its release. Reject a
    # prerelease of exactly the floor so a beta cannot masquerade as stable.
    # A canary ABOVE the floor (`1.4.2-canary.1`) does not match this and passes.
    [[ "$1" != "${2}"-* ]] || return 1
    [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" == "$2" ]]
}

# @sveltejs/adapter-bun THROWS below Bun 1.4.0 — it calls Bun APIs that do not
# exist earlier. What makes that worth a guard rather than a log line is the
# SHAPE of the failure without one, traced through this same script:
#
#   `bun run build` dies inside the adapter
#     -> the `bun run build` step reads it as "build failed" -> rollback()
#     -> rollback resets to the previous commit, which builds fine on
#        adapter-node, so the device looks healthy
#     -> the sha is appended to bad-release on EVERY rollback
#     -> the second poll bans it outright (the two-strikes check above)
#
# Net effect: two "build failed" lines in the journal, then that release is
# never tried again on any pane, while the real cause — a runtime nobody
# upgraded — sits in /var/log/aero-updater.log as a stack trace about
# `Bun.serve`. Nothing anywhere says "your Bun is too old".
#
# WHICH APP, and why the version is not written here twice: the requirement is
# read from the package.json about to be built. If it pulls
# @sveltejs/adapter-bun the floor is enforced; if it does not — aero-1 builds
# with adapter-node — this block does not run at all, so the shipped fleet is
# untouched by this change. A device mid-migration is handled by the tree it is
# migrating to, not by a number someone remembers to update here.
#
# SKIP, and the sha is NOT poisoned: the release is fine, the runtime is not,
# and poisoning would ban a good release for a fault it cannot cause.
#
# HEAD IS RESTORED, which is the part that is easy to get wrong. The
# `git reset --hard` above already moved HEAD to the incoming commit, and LOCAL
# still holds where it came from. Exiting in place would leave HEAD == REMOTE,
# so is_newer would be false on every later poll: the log would say "nothing to
# apply" forever, and upgrading Bun afterwards would never trigger a build — the
# update would have been consumed by a device that could not use it. Putting
# HEAD back makes this skip mean what it says: retried on the next poll,
# indefinitely, until the runtime is upgraded.
#
# (Both pre-build guards restore HEAD through restore_head_after_skip, so the
# skip contract is uniform: retried next poll until the condition clears. The
# free-disk guard used to exit without restoring — a device whose disk stayed
# full consumed every arriving release and served an ever-older build while
# HEAD claimed currency, and "wait for a newer release" was as wrong an answer
# to "you freed the disk" as it is to "you upgraded Bun".)
if [[ -f "${APP_DIR}/package.json" ]] && command grep -q '"@sveltejs/adapter-bun"' "${APP_DIR}/package.json"; then
    BUN_FLOOR="1.4.0"
    # `timeout` so a wedged runtime — corrupt binary, a hung sudo — cannot
    # strand this run inside the reset→restore window, where the
    # TimeoutStartSec SIGKILL would land with HEAD == REMOTE and consume the
    # release exactly as if the guard did not exist. If `timeout` is absent
    # or the version never comes back, `|| echo "unavailable"` fails the
    # floor check and the run skips safely, which is the right direction.
    BUN_HAVE="$(as_app_user timeout 10 "${BUN_BIN}" --version 2>/dev/null || echo "unavailable")"
    if ! bun_meets_floor "${BUN_HAVE}" "${BUN_FLOOR}"; then
        log "SKIP: this app builds with @sveltejs/adapter-bun, which needs Bun >= ${BUN_FLOOR}."
        log "      ${BUN_BIN} reports '${BUN_HAVE}'. Below that floor every build fails inside"
        log "      the adapter and this sha would be banned after two attempts, with the cause"
        log "      buried in a Bun.serve stack trace — so it is checked before install, not"
        log "      discovered during it. The release is fine; the runtime is not."
        log "      Upgrade the runtime, then the next poll retries this commit:"
        log "        curl -fsSL https://bun.sh/install | bash -s 'bun-v${BUN_FLOOR}'"
        restore_head_after_skip
        exit 0
    fi
fi

snapshot_build
reown_app_tree

if use_prebuilt "${REMOTE}"; then
    :
else
log "Installing dependencies..."
( cd "${APP_DIR}" && as_app_user "${BUN_BIN}" install --frozen-lockfile ) 2>&1 | tee -a "${LOG_FILE}" || {
    # A frozen failure on a commit CI verified almost always means the on-disk
    # lockfile is not the commit's — a run of this same pipeline killed
    # mid-write is the cause. Restore it from the index (which the reset
    # --hard above left at the commit) and retry frozen BEFORE the unfrozen
    # fallback: an unfrozen install rewrites bun.lock to whatever satisfies
    # package.json, a dependency set CI never verified. If the index is
    # corrupt too, the checkout fails and the fallback below stays the last
    # resort.
    log "WARN: frozen install failed — restoring bun.lock from ${REMOTE:0:8} and retrying"
    ( cd "${APP_DIR}" && git checkout -- bun.lock ) 2>&1 | tee -a "${LOG_FILE}" || true
    ( cd "${APP_DIR}" && as_app_user "${BUN_BIN}" install --frozen-lockfile ) 2>&1 | tee -a "${LOG_FILE}" || {
        log "WARN: frozen install failed twice — trying without frozen lockfile"
        ( cd "${APP_DIR}" && as_app_user "${BUN_BIN}" install ) 2>&1 | tee -a "${LOG_FILE}" || rollback "bun install failed"
    }
}

# ─── 4. Build ────────────────────────────────────────────────────────────

if [[ -f "${APP_DIR}/package.json" ]] && command grep -q '"build"' "${APP_DIR}/package.json"; then
    log "Building app..."
    ( cd "${APP_DIR}" && as_app_user "${BUN_BIN}" run build ) 2>&1 | tee -a "${LOG_FILE}" || rollback "build failed"
fi
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
UNITS_REINSTALLED=0
if ! git diff --quiet "${LOCAL}" "${REMOTE}" -- deploy/ 2>/dev/null; then
    if [[ -f "${INSTALLER}" ]]; then
        log "deploy/ changed in this release — reinstalling units + cron"
        if bash "${INSTALLER}" --units-only 2>&1 | tee -a "${LOG_FILE}"; then
            UNITS_REINSTALLED=1
        else
            log "WARN: unit reinstall failed — keeping previous units"
        fi
    fi
else
    log "deploy/ unchanged — units left as-is"
fi

# ─── 4c. Hold the restart to the wall-wide apply boundary ────────────────
# Everything above (fetch, install, build, units) is local and invisible to
# the passenger; only the restart changes the picture. See apply_boundary().
# AERO_APPLY_LEAD_SEC=0 disables the hold for bench work.
#
# THE HOLD IS BUDGETED, and it has to be, because this script is the
# ExecStart of a Type=oneshot under TimeoutStartSec. systemd SIGKILLs the whole
# unit when the start exceeds it, and that kill lands in the worst possible
# place: `git reset --hard` and `bun run build` have already run, but
# restart_services() has not. The pane is left serving OLD in-memory code over
# a NEW on-disk build, and because the tree is already at REMOTE the next timer
# fire takes the LOCAL == REMOTE path, logs "Already up to date" and exits 0
# without ever restarting into the build it just made. The other two panes did
# restart, so the wall runs mixed builds PERMANENTLY — and the last line anyone
# sees is "Built. Holding restart …", which reads like success.
#
# So the budget is not advisory. Worst case is a pane that fetches the instant
# the commit lands: apply_boundary puts the boundary 1200..2099 s after the
# commit, and the work runs INSIDE that window rather than before it, so total
# elapsed = apply_at - service_start, not "build then hold". AERO_APPLY_BUDGET_SEC
# must therefore exceed the 2099 s worst case with room for the build, and
# TimeoutStartSec in pi/aero-updater.service must exceed it again. Measured
# before this clamp: 91.3% of (commit-position x poll-lag) pairs were killed.
#
# The clamp is also the only thing standing between a wrong clock and a wedged
# pane. apply_at is derived from the COMMIT's clock; this pane compares it
# against its OWN. An offline Pi with a dead RTC and no network to correct it
# computes a boundary six months in its own past or future, and unclamped that
# is a 182-day sleep — the pane silently stops applying updates forever. Over
# budget is therefore the STRAGGLER branch: restart now. A late restart is
# what that branch already meant, and it is recoverable; a pane wedged for half
# a year is not.
APPLY_LEAD_SEC="${AERO_APPLY_LEAD_SEC:-1200}"
# Validate as digits. In an arithmetic context bash parses "20min" as an
# expression and errors, and inside an `if` condition that is not fatal under
# set -e — so a typo silently took the ELSE and disabled the hold outright,
# with one stderr line nobody reads on a headless Pi.
#
# The digit test is NOT sufficient on its own: "09" passes ^[0-9]+$ and is
# then an invalid OCTAL constant, so `(( APPLY_LEAD_SEC > 0 ))` errors and
# evaluates false — silently disabling the hold, which is the exact failure
# the "20min" check was added to stop. Normalising through 10# is what
# actually fixes it, and it also absorbs "007" rather than rejecting it.
if [[ ! "${APPLY_LEAD_SEC}" =~ ^[0-9]+$ ]]; then
    log "AERO_APPLY_LEAD_SEC='${APPLY_LEAD_SEC}' is not a whole number of seconds — ignoring it and using the 1200s default"
    APPLY_LEAD_SEC=1200
else
    APPLY_LEAD_SEC=$(( 10#${APPLY_LEAD_SEC} ))
fi
APPLY_BUDGET_SEC="${AERO_APPLY_BUDGET_SEC:-2700}"
if [[ ! "${APPLY_BUDGET_SEC}" =~ ^[0-9]+$ ]]; then
    log "AERO_APPLY_BUDGET_SEC='${APPLY_BUDGET_SEC}' is not a whole number of seconds — using 2700"
    APPLY_BUDGET_SEC=2700
else
    APPLY_BUDGET_SEC=$(( 10#${APPLY_BUDGET_SEC} ))
fi
# 2100 is the smallest value that can hold the 2099 s worst case, so a budget
# below it makes the clamp fire on healthy panes and destroys the wall-sync
# property while logging a clock fault the operator does not have.
if (( APPLY_BUDGET_SEC < 2100 )); then
    log "AERO_APPLY_BUDGET_SEC=${APPLY_BUDGET_SEC} is below the 2100s worst case — using 2700"
    APPLY_BUDGET_SEC=2700
fi
# The hold is (lead .. lead+899) after the commit, so a lead at or above the
# budget puts the boundary out of reach for EVERY commit offset and every pane
# straggles. That is wall-sync destroyed with a misleading log, so refuse it
# rather than let an operator talk themselves into a bad value.
if (( APPLY_LEAD_SEC > 0 && APPLY_LEAD_SEC + 899 >= APPLY_BUDGET_SEC )); then
    log "AERO_APPLY_LEAD_SEC=${APPLY_LEAD_SEC} puts the boundary past the ${APPLY_BUDGET_SEC}s budget for most commit offsets — every pane would restart immediately. Lower the lead or raise the budget."
fi
if (( APPLY_BUDGET_SEC > 3000 )); then
    # TimeoutStartSec is 3600. Above 3000 the install+build window shrinks
    # toward nothing, which is how this whole class of bug started.
    log "AERO_APPLY_BUDGET_SEC=${APPLY_BUDGET_SEC} leaves under 10 min of the 3600s TimeoutStartSec for install and build — expect a kill mid-update."
fi
# A run that just reinstalled the units is running under the PREVIOUS
# TimeoutStartSec: systemd armed this start deadline when the unit began, and
# `daemon-reload` re-reads config for FUTURE operations without re-arming a
# deadline already in flight. So the very run that ships a larger budget is
# governed by the old, smaller one — it would be SIGKILLed mid-sleep in exactly
# the way the budget exists to prevent, and because the tree already matches
# release the next poll would log "Already up to date" and never restart into
# the build. Restart immediately instead: one pane early for one poll, which is
# self-limiting and far cheaper than a mixed wall.
if (( UNITS_REINSTALLED )); then
    log "Units were just reinstalled, so this run still has the previous TimeoutStartSec — restarting now. The next poll uses the new budget."
elif (( APPLY_LEAD_SEC > 0 )); then
    # Resolved ONCE. A second `git log` here could come back empty (shallow
    # clone, no commits), and `$(( now_ts - ))` is an arithmetic syntax error
    # which, under set -e, would kill the script HERE — after reset+build and
    # before restart_services, the precise failure this section exists to
    # prevent. Empty commit_ts also makes the boundary land near the epoch, so
    # hold_sec goes hugely negative and the straggler path takes over safely.
    commit_ts=$(git log -1 --format=%ct HEAD 2>/dev/null || echo 0)
    if [[ ! "${commit_ts}" =~ ^[0-9]+$ ]]; then commit_ts=0; fi
    apply_at=$(apply_boundary "${commit_ts}" "${APPLY_LEAD_SEC}")
    now_ts=$(date +%s)
    hold_sec=$(( apply_at - now_ts ))
    # The branch is DECIDED by the pure function so it can be unit-tested, and
    # `hold_sec` is still used for the log lines — the two must agree, and the
    # test pins that they do.
    decision=$(hold_decision "${commit_ts}" "${now_ts}" "${APPLY_LEAD_SEC}" "${APPLY_BUDGET_SEC}")
    if [[ "${decision}" == "now" ]]; then
        log "Boundary $(date -d "@${apply_at}" '+%H:%M:%S' 2>/dev/null || echo "${apply_at}") already passed — restarting now (straggler)"
    elif [[ "${decision}" == "overbudget" ]]; then
        # Not a formatting concern. hold = (lead .. lead+899) − skew, so at the
        # defaults this is reachable ONLY by a negative skew: a local clock
        # behind the commit's. That is the whole point — "restarting now" is
        # indistinguishable from a normal straggler, so name the cause and the
        # magnitude an operator can go and check.
        skew=$(( now_ts - commit_ts ))
        log "Boundary is ${hold_sec}s away, past the ${APPLY_BUDGET_SEC}s service budget — restarting now (straggler). Local clock is ${skew}s from the release commit; check this pane's NTP/fake-hwclock if that is large."
    else
        log "Built. Holding restart ${hold_sec}s until the wall-wide boundary $(date -d "@${apply_at}" '+%H:%M:%S' 2>/dev/null || echo "${apply_at}")"
        sleep "${hold_sec}"
    fi
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
