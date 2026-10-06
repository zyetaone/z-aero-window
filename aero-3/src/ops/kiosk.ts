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

/**
 * Watch the pane. Returns the live state the render loop reads (`shedding`: health-check.sh,
 * served at /api/thermal, says the Pi is hot — fewer pixels, and lighting.ts drops bloom and haze).
 * `frames` is the render loop's count: a visible page that drew no frame in 30 s is wedged (a GPU
 * hang, a lost context that never fired its event). Hidden tabs throttle rAF, so they are spared.
 */
export function keepAlive(engine: AbstractEngine, baseScale: number, frames: () => number) {
	addEventListener('unhandledrejection', recover, { once: true });
	engine.onContextLostObservable.add(recover);
	const state = { shedding: false };
	let framesAt = 0;
	setInterval(async () => {
		if (!document.hidden && frames() === framesAt) recover();
		framesAt = frames();
		fetch('/api/fps', { method: 'POST', body: String(engine.getFps()) }).catch(() => {});
		const thermal = await fetch('/api/thermal').then((r) => r.json()).catch(() => null);
		state.shedding = thermal?.action === 'shed';
		engine.setHardwareScalingLevel(state.shedding ? baseScale * 1.5 : baseScale);
	}, 30_000);
	return state;
}
