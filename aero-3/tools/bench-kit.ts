/**
 * bench-kit — everything the Pi 5 bench needs, built on this machine, so the on-site visit is
 * one copy and one command. No Bun, no `bun install`, no checkout change on the Pi:
 *
 *   dist/bench-kit/aero-3-server   the server and page, compiled for linux-arm64
 *   dist/bench-kit/pi-bench        tools/pi-bench.ts, compiled the same way
 *   dist/bench-kit/run-bench.sh    stops the kiosk and the updater timer, serves, benches, restores
 *
 *   bun aero-3/tools/bench-kit.ts                      # build only
 *   bun aero-3/tools/bench-kit.ts <kiosk-user>@<pi>    # build, then copy to ~/aero-bench on the Pi
 *
 * Then on site: `bun aero-3/tools/ship-pack.ts <kiosk-user>@<pi>` (the data, once), and
 * `ssh -t <kiosk-user>@<pi> bash aero-bench/run-bench.sh [--quick]`. Ssh in as the user that runs
 * the kiosk: the X server (xinit, no auth cookie) only takes that user's windows.
 */
import { $ } from 'bun';

const root = `${import.meta.dir}/..`;
const kit = `${root}/dist/bench-kit`;
$.cwd(root);
// The commit the binaries are built from: pi-bench's own footer reads the Pi checkout's, which can differ.
const built = (await $`git rev-parse --short HEAD`.text()).trim() + ((await $`git status --porcelain -- .`.text()).trim() ? '+dirty' : '');
await $`rm -rf ${kit} && mkdir -p ${kit}`;
await $`bun build --compile --minify --target=bun-linux-arm64 server.ts --outfile ${kit}/aero-3-server`.quiet();
await $`bun build --compile --minify --target=bun-linux-arm64 tools/pi-bench.ts --outfile ${kit}/pi-bench`.quiet();

// The kiosk's own Chromium flags (deploy/pi/aero-kiosk.service), plus the debug port pi-bench drives.
await Bun.write(
	`${kit}/run-bench.sh`,
	`#!/usr/bin/env bash
# Runs ON the Pi, as the kiosk's user. Built by aero-3/tools/bench-kit.ts; results land beside this file.
set -euo pipefail
KIT="$(cd "$(dirname "$0")" && pwd)"
APP="\${AERO_DIR:-/opt/aero-window}/aero-3"   # ship-pack's layout: data paths resolve from here
OUT="$KIT/bench-$(hostname)-$(date +%Y%m%d-%H%M).txt"
[[ -d "$APP/data/buildings" ]] || { echo "no $APP/data/buildings: run tools/ship-pack.ts first" >&2; exit 1; }

restore() {
	kill \${BROWSER:-} \${SERVER:-} 2>/dev/null || true
	sudo systemctl start aero-kiosk aero-updater.timer
	echo "kiosk and updater timer restored"
}
trap restore EXIT
# The updater's 15-min timer could restart the app mid-run; the kiosk holds the display.
sudo systemctl stop aero-updater.timer aero-kiosk

cd "$APP"
PORT=3300 NODE_ENV=production "$KIT/aero-3-server" > "$KIT/server.log" 2>&1 & SERVER=$!
for _ in $(seq 1 90); do curl -sf http://127.0.0.1:3300/api/status > /dev/null && break; sleep 2; done
curl -s http://127.0.0.1:3300/api/status; echo

DISPLAY=:0 chromium --kiosk --use-gl=angle --use-angle=gles --enable-webgl --ignore-gpu-blocklist \\
	--enable-gpu-rasterization --enable-zero-copy --incognito --no-first-run \\
	--autoplay-policy=no-user-gesture-required --noerrdialogs --disable-session-crashed-bubble \\
	--remote-debugging-port=9455 about:blank > "$KIT/chromium.log" 2>&1 & BROWSER=$!
sleep 10

{ echo "kit ${built} on $(hostname) $(uname -m) $(vcgencmd measure_temp 2>/dev/null || true) $(date -Is)"; "$KIT/pi-bench" "$@"; } | tee "$OUT"
echo "results: $OUT"
`
);
await $`chmod +x ${kit}/run-bench.sh ${kit}/aero-3-server ${kit}/pi-bench`;
const sizes = await $`du -sh ${kit}/aero-3-server ${kit}/pi-bench`.text();
console.info(`built ${kit}\n${sizes.trim()}`);

const target = Bun.argv[2];
if (target) {
	await $`rsync -a --partial ${kit}/ ${`${target}:aero-bench/`}`;
	console.info(`copied to ${target}:aero-bench — on site: ssh -t ${target} bash aero-bench/run-bench.sh [--quick]`);
}
