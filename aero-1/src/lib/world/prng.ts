/**
 * Deterministic pseudo-random number generators for the visual layer.
 *
 * ─── WHY THIS EXISTS ──────────────────────────────────────────────────
 * Star positions and cloud cluster positions used to come from
 * `Math.random()`. That works for single-Pi installations but creates
 * a **3-Pi panorama continuity bug**:
 *
 *   left Pi  → random seed A → stars at positions X
 *   centre   → random seed B → stars at positions Y
 *   right    → random seed C → stars at positions Z
 *
 * The three screens stitch together as one panorama, but the random
 * seeds diverge, so the night sky has DIFFERENT stars across each
 * screen — the seam is visible.
 *
 * Solution: deterministic PRNG seeded by a value that's SHARED across
 * all Pis at the same moment. `daySeed()` uses day-of-year × year so:
 *   - All 3 Pis on the same day → same seed → same stars + clouds
 *   - The next day → different seed → different sky
 *
 * ─── ALGORITHM ────────────────────────────────────────────────────────
 * `mulberry32` — small, fast, well-distributed 32-bit PRNG by Tommy
 * Ettinger. Returns a function that produces uniform [0, 1) values.
 * Each `createSeededRng(seed)` call returns an INDEPENDENT generator
 * with its own state — call them concurrently without interference.
 *
 * ─── USAGE ────────────────────────────────────────────────────────────
 *   const rng = createSeededRng(daySeed());
 *   for (let i = 0; i < n; i++) positions[i] = rng() * 100;
 *
 * Replace any `Math.random()` in a build-once-and-never-regen path
 * (star buffer init, cluster position generation, etc).
 *
 * Do NOT introduce live randomness into a rendering path (drift gust noise,
 * twinkle phase offsets WITHIN a star). Every such value must be a PURE FUNCTION
 * OF THE WALL CLOCK via daySeed()/mulberry32(), because three panes form one
 * window and never talk to each other — per-frame randomness desynchronises them
 * and the seam shimmers.
 *
 * This line previously said the opposite ("that should stay live so individual
 * Pis don't synchronise their per-frame oscillation"), which INVERTS invariant
 * #4 and contradicts hash-palette.ts, clouds/wind.ts, Wing.svelte and
 * flight.svelte.ts, all of which derive from the clock instead. It is the file
 * a determinism sweep reads first, so it was instructing the reader to break the
 * rule it exists to support.
 */

/** mulberry32 — 32-bit deterministic PRNG. Returns uniform [0, 1). */
export function createSeededRng(seed: number): () => number {
	let state = seed >>> 0; // ensure unsigned 32-bit
	return () => {
		state = (state + 0x6D2B79F5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * Day-based seed — same value for all callers on the same UTC day.
 * Returns `year * 1000 + dayOfYear` so successive days produce
 * distinct seeds; the year multiplier prevents collisions across years.
 */
export function daySeed(now: Date = new Date()): number {
	const year = now.getUTCFullYear();
	const start = Date.UTC(year, 0, 0);
	const diff = now.getTime() - start;
	const dayOfYear = Math.floor(diff / 86_400_000);
	return year * 1000 + dayOfYear;
}

/** djb2 string hash → unsigned 32-bit. Pair with daySeed() to derive
 *  per-entity deterministic seeds: `createSeededRng((daySeed() ^ hashString(id)) >>> 0)`. */
export function hashString(id: string): number {
	let h = 5381;
	for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
	return h >>> 0;
}
