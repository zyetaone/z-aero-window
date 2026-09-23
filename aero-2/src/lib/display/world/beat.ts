/**
 * beat.ts — slow, deterministic wander for paint scalars.
 *
 * Three layers want the same thing: a value that drifts the way real air,
 * water and lamps do, identical on three panes, and cheap on a Pi. That is
 * one function: the product of two sines with coprime periods, so the curve
 * wanders for hours without repeating, pure in the wall clock so the panes
 * agree without exchanging anything, and quantised so a MapLibre paint write
 * lands a few times a minute instead of every frame (see 5fb22036).
 */

/** Two-beat wander in [-1, 1]; `p1`, `p2` in seconds, coprime for a long orbit. */
export function slowBeat(wallSec: number, p1: number, p2: number): number {
	return Math.sin((wallSec * 2 * Math.PI) / p1) * Math.sin((wallSec * 2 * Math.PI) / p2);
}

/** Round to `step` (0.01 by default): equal primitives do not notify a $derived. */
export function quantize(value: number, step = 0.01): number {
	return Math.round(value / step) * step;
}

/**
 * Rotate a dash pattern by `offset` line-widths, so a fixed set of shifted
 * patterns played in order reads as dashes travelling along the line
 * (MapLibre's animate-a-line recipe, for any pattern). The result starts with
 * a dash as MapLibre requires: a cut inside a gap opens with a zero dash.
 */
export function shiftDash(pattern: readonly number[], offset: number): number[] {
	const period = pattern.reduce((a, b) => a + b, 0);
	let o = ((offset % period) + period) % period;
	let i = 0;
	while (o >= pattern[i] && o > 0) {
		o -= pattern[i];
		i = (i + 1) % pattern.length;
	}
	const tail = [pattern[i] - o, ...pattern.slice(i + 1), ...pattern.slice(0, i)];
	if (o > 0) tail.push(o);
	// Odd index = we cut inside a gap: lead with a zero-length dash.
	const out = i % 2 === 1 ? [0, ...tail] : tail;
	// Keep dash/gap parity across repeats: an odd array flips on the next period.
	if (out.length % 2 === 1) out.push(0);
	return out;
}
