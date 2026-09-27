#!/usr/bin/env node
/**
 * shot — headless screenshot of a running dev/prod server, for visual A/Bs.
 *
 * Exists because nothing else in the toolchain can see the thing this project
 * ships. `bun run check` and the unit suite verify shape, never appearance:
 * fog density, cloud counts, night-light balance and imagery filters are all
 * runtime visual constants with no test coverage. Every one of those has
 * shipped a regression that was green in CI.
 *
 * Usage:
 *   node tools/shot.mjs "http://localhost:5173/?time=22" out.png [--wait 60000]
 *
 * Sibling of smoke-routes.mjs (same CDP dependency); that one asserts a route
 * RENDERED, this one captures what it looked like.
 *
 * ─── ⚠ THREE TRAPS, EACH COST A WASTED CAPTURE ──────────────────────────────
 * 1. Do NOT use `chrome-headless-shell --screenshot --virtual-time-budget`.
 *    Virtual time pauses while any request is in flight, and Cesium retries
 *    404 polar/ocean VIIRS tiles forever, so the budget never expires and the
 *    screenshot never fires. Real-time wait + explicit capture is the fix.
 * 2. WAIT TIME IS THE CAMERA ORBIT PHASE. Two frames captured at different
 *    --wait values show different camera positions and are NOT comparable.
 *    Hold it constant across every frame of an A/B.
 * 3. Check the probe line this prints. A run where imagery never loaded gives
 *    a ~150KB PNG of bare globe baseColor (loaded frames are ~400-900KB) and
 *    bootGone:false. Remote tiles make load time variable.
 *
 * Also pin the scenario — ?time= &weather= &location= &altitude= — or the
 * director randomises weather per boot and the comparison is meaningless.
 *
 * Renders through SwiftShader, NOT the Pi GPU. Colour and geometry are
 * faithful; GPU-specific artifacts (bloom, the golden-hour sun sprite) are not.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import CDP from 'chrome-remote-interface';

// Newest installed Playwright headless shell, or CHROME=/path to override.
// A pinned revision rotted twice (1228 was uninstalled by a playwright bump).
import { readdirSync } from 'node:fs';
const CHROME =
	process.env.CHROME ??
	(() => {
		const dir = `${homedir()}/Library/Caches/ms-playwright`;
		const rev = readdirSync(dir)
			.filter((d) => d.startsWith('chromium_headless_shell-'))
			.sort()
			.at(-1);
		return `${dir}/${rev}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
	})();

const arg = (name, dflt) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? dflt : process.argv[i + 1];
};
const [url, out] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!url || !out) {
	console.error('usage: node tools/shot.mjs <url> <out.png> [--wait ms] [--port n]');
	process.exit(2);
}
const WAIT = Number(arg('wait', 60_000));
const PORT = Number(arg('port', 9222));

const chrome = spawn(CHROME, [
	'--headless',
	`--remote-debugging-port=${PORT}`,
	'--remote-allow-origins=*',
	'--disable-gpu-sandbox',
	'--use-gl=angle',
	'--use-angle=swiftshader',
	'--enable-unsafe-swiftshader',
	'--hide-scrollbars',
	'--window-size=1280,900',
	'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let client;
try {
	for (let i = 0; ; i++) {
		try { client = await CDP({ port: PORT }); break; }
		catch (e) { if (i > 60) throw e; await sleep(500); }
	}
	const { Page, Runtime } = client;
	await Page.enable();
	await Page.navigate({ url });
	// Real-time settle: tiles, terrain and the boot dissolve all need
	// wall-clock, and the scene never reaches network-idle (see trap 1).
	await sleep(WAIT);

	const { data } = await Page.captureScreenshot({ format: 'png' });
	await writeFile(out, Buffer.from(data, 'base64'));

	const { result } = await Runtime.evaluate({
		expression: `JSON.stringify({
			canvases: [...document.querySelectorAll('canvas')].map(c => c.width + 'x' + c.height),
			bootGone: !document.querySelector('.boot-lockup, [data-boot-lockup]'),
		})`,
		returnByValue: true,
	});
	console.log(`wrote ${out}`);
	console.log(`probe: ${result.value}`);
	if (!JSON.parse(result.value).canvases.length) {
		console.error('WARNING: no canvas — the scene did not render, frame is not usable');
		process.exitCode = 1;
	}
} finally {
	if (client) await client.close();
	chrome.kill();
}
