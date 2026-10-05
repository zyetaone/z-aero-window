#!/usr/bin/env bash
#
# ship-pack — copy aero-3's data onto a Pi, and prove the running server sees it.
#
# data/ is gitignored, so the release branch the updater pulls never carries it
# (aero-2/tools/ship-tiles.sh explains the same gap for aero-2). aero-3 needs a
# different slice: only the zooms it reads (Sentinel-2 z7/8/11/12, Terrarium
# z8/10, VIIRS z8), the road packs, and its own OSM building packs. ~320 MB,
# against aero-2's 3.6 GB of Terrarium alone.
#
#   bash aero-3/tools/ship-pack.sh pi@10.0.0.31            # from the repo root
#   bash aero-3/tools/ship-pack.sh pi@10.0.0.31 --dry-run
#
# rsync over ssh with --partial: resumable on a flaky wall LAN, and a no-op for
# what the Pi already has. Then the app restarts (data routes mount at startup)
# and the DEVICE is asked which routes it serves: rsync's exit code is not proof.

set -euo pipefail
cd "$(dirname "$0")/../.."

TARGET="${1:-}"
REMOTE_DIR="/opt/aero-window"
DRY_RUN=""
shift || true
while [[ $# -gt 0 ]]; do
	case "$1" in
		--dir) REMOTE_DIR="$2"; shift 2 ;;
		--dry-run) DRY_RUN="--dry-run"; shift ;;
		*) echo "unknown option: $1" >&2; exit 2 ;;
	esac
done
if [[ -z "$TARGET" ]]; then
	echo "usage: bash aero-3/tools/ship-pack.sh <user@host> [--dir /opt/aero-window] [--dry-run]" >&2
	exit 2
fi

PACK=(
	./data/tiles/sentinel2/7 ./data/tiles/sentinel2/8 ./data/tiles/sentinel2/11 ./data/tiles/sentinel2/12
	./aero-2/data/tiles/terrarium/8 ./aero-2/data/tiles/terrarium/10
	./aero-2/data/tiles/viirs/8
	./data/roads
	./aero-3/data/buildings
)
for p in "${PACK[@]}"; do
	[[ -d "$p" && -n "$(ls -A "$p")" ]] || { echo "missing or empty locally: $p (fetch it before shipping)" >&2; exit 1; }
done

echo "shipping $(du -shc "${PACK[@]}" | tail -1 | cut -f1) to ${TARGET}:${REMOTE_DIR}"
rsync -a --relative --partial --info=progress2 ${DRY_RUN} "${PACK[@]}" "${TARGET}:${REMOTE_DIR}/"
[[ -n "$DRY_RUN" ]] && exit 0

echo "restarting the app so the new folders mount, then asking it what it serves..."
ssh "$TARGET" "sudo systemctl restart aero-app && for i in \$(seq 1 30); do curl -sf http://127.0.0.1:3000/api/status && exit 0; sleep 2; done; exit 1" > /tmp/aero3-status.json
cat /tmp/aero3-status.json; echo
for route in tiles/imagery tiles/terrain tiles/lights buildings roads models; do
	grep -q "\"$route\"" /tmp/aero3-status.json || { echo "the device does not serve /$route" >&2; exit 1; }
done
echo "ok: the device serves every aero-3 data route"
