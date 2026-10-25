/**
 * Keeping an unattended pane alive: a kiosk has no one to press reload. A failed boot or a lost
 * GL context reloads (budgeted), a wedged render loop is caught, the frame rate goes to this
 * pane's server for health-check.sh, and a hot Pi sheds pixels until it cools.
 */
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';

const RECOVERIES = 'aero-recoveries';

/**
 * Reload after a failure, but not in a loop: at most three error reloads an hour, then one every
 * five minutes. The count lives in sessionStorage, which survives a reload of the same tab.
 */
export function recover() {
	if (recover.once) return;
	recover.once = true;
	const now = Date.now();
	let recent: number[] = [];
	try {
		recent = (JSON.parse(sessionStorage.getItem(RECOVERIES) ?? '[]') as number[]).filter((t) => now - t < 3_600_000);
		sessionStorage.setItem(RECOVERIES, JSON.stringify([...recent, now]));
	} catch {}
	setTimeout(() => location.reload(), recent.length >= 3 ? 300_000 : 10_000);
}
recover.once = false;

// The page's own last error goes to this pane's server (/api/status lastError), which
// health-check.sh carries in the heartbeat: a dark pane is diagnosed from /admin, not over ssh.
const report = (what: string) => fetch('/api/error', { method: 'POST', body: what.slice(0, 200) }).catch(() => {});
let booting = true;

/**
 * main.ts's first statement: a boot that throws before the engine exists (Chromium up before the
 * GPU, a failed fetch of the page's own data) still reports and reloads. Past boot, an uncaught
 * error is reported only; a rejection still reloads, as before.
 */
export function guardBoot() {
	addEventListener('error', (e: ErrorEvent) => {
		report(e.message || String(e.error));
		if (booting) recover();
	});
	addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
		report(String(e.reason?.message ?? e.reason));
		recover();
	});
}

/**
 * Watch the pane. Returns the live state the render loop reads (`shedding`: health-check.sh,
 * served at /api/thermal, says the Pi is hot — fewer pixels, and lighting.ts drops bloom and haze).
 * `frames` is the render loop's count: a visible page that drew no frame in 30 s is wedged (a GPU
 * hang, a lost context that never fired its event). Hidden tabs throttle rAF, so they are spared.
 */
export function keepAlive(engine: AbstractEngine, baseScale: number, frames: () => number) {
	booting = false;
	engine.onContextLostObservable.add(recover);
	engine.onContextLostObservable.add(() => report('WebGL context lost'));
	const state = { shedding: false };
	let [framesAt, idle] = [0, 0];
	setInterval(async () => {
		// The scene builds for a minute or more on a Pi before the first frame: the wedge check arms
		// on that frame. A page that never draws one gets five minutes, then the reload budget.
		if (!document.hidden && frames() === framesAt && (frames() > 0 || ++idle >= 10)) recover();
		framesAt = frames();
		fetch('/api/fps', { method: 'POST', body: String(engine.getFps()) }).catch(() => {});
		const thermal = await fetch('/api/thermal').then((r) => r.json()).catch(() => null);
		state.shedding = thermal?.action === 'shed';
		engine.setHardwareScalingLevel(state.shedding ? baseScale * 1.5 : baseScale);
	}, 30_000);
	return state;
}
