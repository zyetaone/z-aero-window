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
