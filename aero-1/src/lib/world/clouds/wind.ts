/**
 * Wind envelope for the cloud deck — pure functions of the wall second.
 *
 * Two slow, mutually irrational sinusoids multiplied together give a
 * quasi-random gust in [0.45, 1.55] and a wind-speed modulation in
 * [0.6, 1.6] that ebbs and surges over ~6 min but never reverses. Both used
 * to be driven by an accumulator (`_windT += dt`) inside the render task, so
 * three panes ran three different gust patterns from three boot instants and
 * a slow pane ran its wind slow.
 *
 * What the sprites actually need is the INTEGRAL of those rates — a phase to
 * set rotation from, not a delta to add. Adding `rate * dt` each frame is a
 * second accumulator with the same three-boots problem (and a slow pane
 * integrates short). So the exports are the closed-form integrals: every
 * pane reads the same phase at the same instant, a rebooted pane rejoins
 * mid-gust, and there is no per-frame state at all.
 *
 *   gustAt(t)    = 1 + 0.55·sin(0.137t)·cos(0.273t)      (kept for tests)
 *   gustPhaseAt  = ∫ gustAt        = t + 0.275·(cos(0.136t)/0.136 − cos(0.41t)/0.41)
 *   windMagAt(t) = 1.1 + 0.5·sin(0.017t)·cos(0.041t)
 *   windPhaseAt  = ∫ windMagAt     = 1.1t + 0.25·(cos(0.024t)/0.024 − cos(0.058t)/0.058)
 *
 * (product-to-sum: sin a·cos b = ½[sin(a+b) + sin(a−b)].)
 */
export function gustAt(wallSec: number): number {
	return 1 + 0.55 * Math.sin(wallSec * 0.137) * Math.cos(wallSec * 0.273);
}

export function gustPhaseAt(wallSec: number): number {
	return wallSec + 0.275 * (Math.cos(0.136 * wallSec) / 0.136 - Math.cos(0.41 * wallSec) / 0.41);
}

export function windMagAt(wallSec: number): number {
	return 1.1 + 0.5 * Math.sin(wallSec * 0.017) * Math.cos(wallSec * 0.041);
}

export function windPhaseAt(wallSec: number): number {
	return 1.1 * wallSec + 0.25 * (Math.cos(0.024 * wallSec) / 0.024 - Math.cos(0.058 * wallSec) / 0.058);
}
