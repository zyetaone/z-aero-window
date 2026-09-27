/**
 * Wind envelope for the cloud deck — pure functions of the wall second.
 *
 * Two slow, mutually irrational sinusoids multiplied together give a
 * quasi-random gust in [0.45, 1.55] and a wind-speed modulation in
 * [0.6, 1.6] that ebbs and surges over ~6 min but never reverses. Both used
 * to be driven by an accumulator (`_windT += dt`) inside the render task, so
 * three panes ran three different gust patterns from three boot instants and
 * a slow pane ran its wind slow. Read from the wall second, every pane sees
 * the same gust at the same instant and a rebooted pane rejoins mid-gust.
 */
export function gustAt(wallSec: number): number {
	return 1 + 0.55 * Math.sin(wallSec * 0.137) * Math.cos(wallSec * 0.273);
}

export function windMagAt(wallSec: number): number {
	return 1.1 + 0.5 * Math.sin(wallSec * 0.017) * Math.cos(wallSec * 0.041);
}
