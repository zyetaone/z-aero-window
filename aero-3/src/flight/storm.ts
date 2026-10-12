/**
 * Lightning on a storm day (weather.ts `storm`), pure on the wall clock: every pane
 * asks for the same second and gets the same strike, so the wall flashes as one
 * (aero-2's strikeAt). Where it strikes is relative to the pin, the clouds' centre.
 */
import { hash } from '#math.ts';

/** One chance per wall second, so a strike every this many seconds on average. */
export const STRIKE_EVERY_SEC = 9;
export const SOUND_MPS = 343;

export type Strike = { flash: number; x: number; z: number; distM: number; startSec: number };

/** One strike's light, `t` s after it starts: the return stroke, a dip, a re-strike, the fade. */
export function flashAt(t: number) {
	if (t < 0 || t > 0.8) return 0;
	if (t < 0.05) return 1;
	if (t < 0.11) return 0.25;
	if (t < 0.17) return 0.8;
	return 0.8 * Math.exp(-(t - 0.17) / 0.12);
}

/** The strike lighting the sky at `wallSec`, or null. `seed` is the day's (Weather.seed). */
export function strikeAt(seed: number, wallSec: number): Strike | null {
	const s = Math.floor(wallSec);
	// A strike from late in the previous second can still be fading.
	for (const k of [s, s - 1]) {
		const h = (i: number) => hash(seed ^ Math.imul(k * 4 + i, 0x2c1b3c6d));
		if (h(0) >= 1 / STRIKE_EVERY_SEC) continue;
		const startSec = k + 0.9 * h(1);
		const flash = flashAt(wallSec - startSec);
		if (!flash) continue;
		const [bearing, distM] = [2 * Math.PI * h(2), 4_000 + 26_000 * h(3)];
		return { flash, x: distM * Math.sin(bearing), z: distM * Math.cos(bearing), distM, startSec };
	}
	return null;
}
