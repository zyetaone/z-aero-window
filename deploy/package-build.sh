#!/usr/bin/env bash
# Package one app as the fleet's prebuilt release: build/ + production
# node_modules + the build-time inputs it was compiled with.
#
#   deploy/package-build.sh aero-1        → dist-prebuilt/aero-1.tar.gz{,.sha256}
#
# CI runs this for every green main push and attaches the result to a
# `build-<sha>` GitHub release. aero-updater.sh downloads it instead of running
# `bun install` (the full dev tree, from the network) and a >6 min `vite build`
# on the Pi. Copy dist-prebuilt/ to a pen drive as
# /media/aero/prebuilt/build-<sha>/ and an offline Pi skips both too.
#
# Vite inlines some env at BUILD time, so a build is only valid for devices
# whose values match. Those values are recorded in build-inputs.env; the updater
# compares them with its own and builds on-device on any difference. The
# caller sets them (CI: the fleet defaults) — this script only records them.
set -euo pipefail

APP="${1:?usage: package-build.sh <aero-1|aero-2>}"
ROOT="$(git rev-parse --show-toplevel)"
APP_DIR="${ROOT}/${APP}"
OUT="${OUT_DIR:-${ROOT}/dist-prebuilt}"

# Every env name Vite or Kit inlines for this app. Keep in step with
# vite.config.ts and (aero-2) src/env.ts — a missing name here is a device
# setting the prebuilt silently ignores.
case "${APP}" in
    aero-1) INPUTS="VITE_TILE_SERVER_URL VITE_CESIUM_ION_TOKEN VITE_MAPBOX_TOKEN" ;;
    # aero-2 never reads VITE_TILE_SERVER_URL, but every Pi's config.env exports
    # it, and the updater treats a set VITE_* the build never recorded as a
    # mismatch — so it is recorded here, or no aero-2 Pi would ever match.
    aero-2) INPUTS="PUBLIC_TILE_SERVER_URL PUBLIC_WALL_ORIGIN AERO_MEDIA_ORIGINS VITE_TILE_SERVER_URL VITE_MAPBOX_TOKEN" ;;
    *) echo "unknown app: ${APP}" >&2; exit 2 ;;
esac

# The release is public. A token inlined into the client bundle would be
# published to the world, not just to the LAN.
for k in VITE_CESIUM_ION_TOKEN VITE_MAPBOX_TOKEN; do
    [[ -z "${!k:-}" ]] || { echo "refusing to package with ${k} set: the release is public" >&2; exit 1; }
done

STAGE="$(mktemp -d)"
trap 'rm -rf "${STAGE}"' EXIT

( cd "${APP_DIR}" && bun run build )

cp "${APP_DIR}/package.json" "${APP_DIR}/bun.lock" "${STAGE}/"
( cd "${STAGE}" && bun install --production --frozen-lockfile --ignore-scripts )
# CI builds on x86-64 and the Pi is arm64. Pure-JS node_modules run on both;
# a compiled addon would not, so refuse rather than ship a pane that crashes.
if /usr/bin/find "${STAGE}/node_modules" -name '*.node' -print -quit | command grep -q .; then
    echo "native addon in production deps — a prebuilt would not run on the Pi" >&2
    exit 1
fi

for k in ${INPUTS}; do printf '%s=%s\n' "${k}" "${!k:-}"; done > "${STAGE}/build-inputs.env"
git -C "${ROOT}" rev-parse HEAD > "${STAGE}/COMMIT"

# aero-1's server.ts imports src/ through the `$lib` alias, which Bun resolves
# from the tsconfig `svelte-kit sync` generates (normally during `bun install`'s
# prepare step — the step a prebuilt skips). Its paths are relative, so it ships.
mkdir -p "${STAGE}/.svelte-kit"
if [[ -f "${APP_DIR}/.svelte-kit/tsconfig.json" ]]; then
    cp "${APP_DIR}/.svelte-kit/tsconfig.json" "${STAGE}/.svelte-kit/tsconfig.json"
fi

mkdir -p "${OUT}"
tar czf "${OUT}/${APP}.tar.gz" -C "${APP_DIR}" build -C "${STAGE}" node_modules .svelte-kit build-inputs.env COMMIT
( cd "${OUT}" && sha256sum "${APP}.tar.gz" > "${APP}.tar.gz.sha256" )
echo "packaged ${OUT}/${APP}.tar.gz ($(du -h "${OUT}/${APP}.tar.gz" | cut -f1))"
