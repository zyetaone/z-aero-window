/**
 * clearance.ts — how high the ground is under the aircraft, and whether we
 * actually measured it.
 *
 * `place.groundElevationM` is one number for a whole region, and it is NOT a
 * terrain clearance: measured against the real DEM across each orbit, mean plus
 * climb floor sits BELOW the local peak at five of eleven locations — Las Vegas
 * by 2,072 m, Dubai by 1,119 m, Mumbai by 990 m. So the renderer is asked what
 * the ground really is, and the mean is only the floor.
 *
 * That policy lived twice, once in each renderer bridge, and the two engines
 * disagreeing about where the ground is was a documented regression: the same
 * location flew clean on MapLibre and through a mountain on Cesium. The Cesium
 * bridge is deleted now and MapLibre is the only caller, so this is one policy
 * with one caller — kept, not inlined, because `sampled` is the provenance flag
 * `AeroDisplay.terrain` counts and that has to live somewhere both the caller
 * and the counter can see.
 *
 * It also still owns a vertical-frame rule worth not relearning: MapLibre's
 * `queryTerrainElevation` returns the DRAWN height with exaggeration already
 * applied, so the mean and the sample must arrive in the SAME frame. Any second
 * renderer sampling real metres MSL has to convert before it calls this, not
 * after.
 */

export interface Clearance {
	/** Ground height to fly above, in the caller's own vertical frame. */
	groundM: number;
	/**
	 * Did the terrain actually answer?
	 *
	 * This is the whole reason the function returns an object rather than a
	 * number. The failure mode this codebase keeps paying for is an absence
	 * that reads as a measurement, and here it is invisible by construction:
	 * when no DEM tile has decoded, the query returns nothing, the mean wins,
	 * and the camera flies a perfectly reasonable altitude over ground drawn at
	 * sea level. Nothing is thrown and nothing looks wrong. The only way to
	 * know is to count how often this was false — see `AeroDisplay.terrain`.
	 */
	sampled: boolean;
}

/**
 * The regional mean is the FLOOR; a real terrain sample wins when it is higher.
 *
 * A tile that has not loaded yet must never be able to lower the camera, so
 * anything non-finite — null, undefined, NaN — falls back to the mean rather
 * than to zero. `Math.max(mean, sample ?? 0)` gets the same answer for land,
 * but it routes "unknown" through a literal sea level on the way, and that is
 * the substitution worth not writing down.
 */
export function resolveClearance(
	meanGroundM: number,
	sampledM: number | null | undefined
): Clearance {
	if (typeof sampledM !== 'number' || !Number.isFinite(sampledM)) {
		return { groundM: meanGroundM, sampled: false };
	}
	return { groundM: Math.max(meanGroundM, sampledM), sampled: true };
}

/**
 * Standing clearance carried above the resolved datum, metres.
 *
 * The climb floor clears the regional MEAN, but terrain varies around it: at
 * 400 m AGL over ground that runs 150 m above its mean, the margin is 250 m
 * on paper and zero wherever the DEM has not decoded yet (the query falls
 * back to the mean while the mesh draws the peak). A camera inside the mesh
 * fills the frame with dark unlit hillside — the blur-and-black reports.
 * The floor stays where the operator put it; this margin rides above whatever
 * the datum resolves to, so low flight stays low and stops clipping.
 */
export const DATUM_MARGIN_M = 120;

/**
 * How fast the smoothed datum falls toward a lower target: the rate
 * constant of the exponential approach, per second. The remaining gap
 * shrinks by e^-2.5 (~92%) every second.
 *
 * Rises are instant (never ease into a ridge); falls glide so the camera
 * does not step off cliff edges. 2.5 halves the burial window of the old
 * 1.5 without reintroducing the stepping the glide exists to prevent.
 */
export const DATUM_FALL_PER_SEC = 2.5;

/**
 * A fall in progress: where it started, when, and where it is going.
 *
 * The anchor for a CLOSED-FORM glide. The old `smoothDatum` integrated
 * `prev + (goal - prev) * dt * rate` frame by frame on a wall-clock delta —
 * rate-correct, but the value at any second depended on which frames a
 * pane had rendered since the fall began (`+= dt` in disguise; ADR-007).
 * Keyed on the wall second instead, `datumAt` is a pure function of
 * (anchor, wallSec): two panes holding the same anchor agree at every
 * second whatever their frame cadence, and a pane that drops frames does
 * not glide slower.
 *
 * What the anchor cannot do: survive a reboot. It is the second the DEM
 * sample under THIS pane changed, and that is pane-local by nature (tiles
 * decode when they decode). A pane that boots mid-glide has no anchor and
 * stands on the goal at once — as it always did — and its neighbours
 * converge on it within a few time constants. The closed form removes
 * frame-phase drift, not tile-timing drift. Replaced, never mutated.
 */
export interface DatumGlide {
	/** Datum at the anchor second. */
	readonly fromM: number;
	/** Wall second the fall was anchored at. */
	readonly fromWallSec: number;
	/** Margined target the fall approaches; never crossed. */
	readonly goalM: number;
}

/**
 * The datum at `wallSec` for a glide: an exponential approach from the
 * anchor toward the goal. `exp` is strictly positive, so a fall never
 * crosses below its goal; a second before the anchor reads the anchor.
 */
export function datumAt(glide: DatumGlide, wallSec: number): number {
	const elapsed = Math.max(0, wallSec - glide.fromWallSec);
	return glide.goalM + (glide.fromM - glide.goalM) * Math.exp(-DATUM_FALL_PER_SEC * elapsed);
}

/**
 * Advance the glide for a new terrain sample at `wallSec`.
 *
 * Pure so the burial contract is unit-testable: a newly sampled ridge is
 * climbed INSTANTLY (the glide re-anchors ON the margined goal whenever the
 * goal is at or above the current datum), a lower goal is approached from
 * above and never crossed, and the margin holds in both directions. An
 * unchanged goal returns the SAME anchor, so a fall in progress stays a
 * function of the wall second alone; a goal that moves lower again
 * mid-fall re-anchors at the current datum so the picture never jumps.
 */
export function glideDatum(prev: DatumGlide | null, target: number, wallSec: number): DatumGlide {
	const goal = target + DATUM_MARGIN_M;
	if (prev === null) return { fromM: goal, fromWallSec: wallSec, goalM: goal };
	if (goal === prev.goalM) return prev;
	const current = datumAt(prev, wallSec);
	if (goal >= current) return { fromM: goal, fromWallSec: wallSec, goalM: goal };
	return { fromM: current, fromWallSec: wallSec, goalM: goal };
}
