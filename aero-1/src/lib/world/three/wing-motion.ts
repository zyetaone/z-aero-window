/**
 * Wing sway and anti-collision strobe — pure functions of the wall second.
 *
 * Both were accumulators (`_swayT += dt`, `_strobeT += dt`) in the render
 * task: each pane's wing swayed on its own phase from its own boot, and a
 * slow pane strobed slow. From the wall second, three wings sway together
 * and the strobe fires on the same instant on every pane.
 */

/** Perpetual gentle roll, degrees: two detuned sines, ±~2.5° at ~0.08–0.16 Hz. */
export function swayDeg(wallSec: number): number {
	return 1.7 * Math.sin(wallSec * 0.52) + 0.8 * Math.sin(wallSec * 0.97 + 1.3);
}

export const STROBE_PERIOD_S = 1.1;
export const STROBE_PULSE_S = 0.12;
export const STROBE_GAP_S = 0.16;

/** Double-flash anti-collision strobe (737 cadence): two pulses GAP apart, once per PERIOD. */
export function strobeOn(wallSec: number): boolean {
	const t = ((wallSec % STROBE_PERIOD_S) + STROBE_PERIOD_S) % STROBE_PERIOD_S;
	return t < STROBE_PULSE_S || (t >= STROBE_GAP_S && t < STROBE_GAP_S + STROBE_PULSE_S);
}
