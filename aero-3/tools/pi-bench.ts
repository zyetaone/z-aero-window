/**
 * Pi bench: median and p95 frame period for every place, day and night, in the
 * kiosk's own Chromium (GPU flags and all), with ablations on the heaviest scene.
 * Run ON the Pi, from aero-3/, with the server up and Chromium on a debug port:
 *
 *   sudo systemctl stop aero-kiosk              # free the display (start it again after)
 *   PORT=3300 bun server.ts &
 *   DISPLAY=:0 chromium --kiosk --use-gl=angle --use-angle=gles --enable-webgl --ignore-gpu-blocklist \
 *     --enable-gpu-rasterization --enable-zero-copy --incognito --no-first-run \
 *     --remote-debugging-port=9455 about:blank &
 *   bun tools/pi-bench.ts                        # ~25 min; --quick for three scenes
 *
 * Scenes are pinned (place, clock, weather, no blind, no rotation) so two runs
 * render the same thing; a number from an unpinned wall is noise
 * (docs/PI-PERF-PROCESS.md). Median, not mean: the distribution is bimodal.
 */
const arg = (name: string, fallback: string) => (Bun.argv.includes(`--${name}`) ? Bun.argv[Bun.argv.indexOf(`--${name}`) + 1]! : fallback);
const BASE = arg('base', 'http://127.0.0.1:3300');
const CDP = Number(arg('cdp-port', '9455'));
const [WARM_S, MEASURE_S] = [20, 30];
const { PLACES } = await import('../src/flight/places.ts');

const pinned = (place: string, clock: number, extra = '') => `place=${place}&clock=${clock}&weather=scattered&blind=0&audio=0&hud=0${extra}`;
let scenes: [string, string][] = Object.keys(PLACES).flatMap((p) => [[`${p} day`, pinned(p, 12)], [`${p} night`, pinned(p, 22)]] as [string, string][]);
// What each layer costs, on the heaviest scene.
for (const [label, extra] of [['no wing', '&wing=0'], ['no bloom', '&glow=0'], ['no trees', '&trees=0'], ['caps', '&caps=1'], ['scale 1.5', '&scale=1.5']])
	scenes.push([`dubai night, ${label}`, pinned('dubai', 22, extra)]);
if (Bun.argv.includes('--quick')) scenes = scenes.filter(([l]) => ['hyderabad night', 'dubai night', 'himalayas day'].includes(l));

const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map<number, (v: any) => void>();
ws.onmessage = (e) => {
	const m = JSON.parse(String(e.data));
	pending.get(m.id)?.(m.result);
	pending.delete(m.id);
};
const send = (method: string, params = {}, sessionId?: string) =>
	new Promise<any>((resolve) => {
		pending.set(++id, resolve);
		ws.send(JSON.stringify({ id, method, params, sessionId }));
	});
const { targetInfos } = await send('Target.getTargets');
const page = targetInfos.find((t: { type: string }) => t.type === 'page');
const { sessionId } = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
const evaluate = async (expression: string) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)).result.value;

const rows: string[] = [];
for (const [label, query] of scenes) {
	await send('Page.navigate', { url: `${BASE}/?${query}` }, sessionId);
	let ready = false;
	for (let i = 0; i < 240 && !ready; i++) (await Bun.sleep(500), (ready = (await evaluate("document.documentElement.dataset.ready === '1'")) === true));
	if (!ready) {
		rows.push(`${label.padEnd(30)} did not start in 120 s`);
		continue;
	}
	await Bun.sleep(WARM_S * 1000);
	const r = await evaluate(`new Promise((done) => {
		const periods = []; let last = performance.now(); const start = last;
		const tick = (now) => { periods.push(now - last); last = now; now - start < ${MEASURE_S * 1000} ? requestAnimationFrame(tick) : done(periods); };
		requestAnimationFrame(tick);
	}).then((p) => { p.shift(); p.sort((a, b) => a - b); const q = (x) => p[Math.min(p.length - 1, Math.floor(p.length * x))]; return { n: p.length, median: q(0.5), p95: q(0.95) }; })`);
	const fps = (ms: number) => `${ms.toFixed(0).padStart(5)} ms ${(1000 / ms).toFixed(1).padStart(5)} fps`;
	rows.push(`${label.padEnd(30)} median ${fps(r.median)}   p95 ${fps(r.p95)}   (${r.n} frames)`);
	console.log(rows.at(-1));
}
ws.close();
console.log(`\naero-3 ${Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD']).stdout.toString().trim()}, ${MEASURE_S}s after ${WARM_S}s warm-up, weather pinned scattered\n` + rows.join('\n'));
