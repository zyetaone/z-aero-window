/**
 * world/curves — THE cross-boundary single source of truth for how
 * time-of-day + nightFactor drive the whole scene's day/dusk/night response.
 *
 * ─── WHY THIS LIVES HERE (not in world/three/) ──────────────────────────────
 * Both renderers need these curves: the Three.js overlay (clouds, veil,
 * sun-glow, stars, ambient, IBL sky) AND the Cesium side (compose.ts
 * skyAtmosphere / fog / exposure / atmosphereLight). They used to derive
 * day/night INDEPENDENTLY — Three from this SSOT, Cesium from NIGHT_PALETTE —
 * keyed on the same T constants but hand-tuned separately, so they drifted (the
 * "white horizon band seam" where the Cesium sky and the Three veil disagree).
 *
 * This module is FRAMEWORK-FREE — it imports neither `three` nor `cesium`, only
 * pure math from $lib/utils. That's what lets `world/` (Cesium, isolated per
 * invariant #1) and `world/three/` both import it without breaking the boundary:
 * lighting math is framework-agnostic.
 *
 * ─── THE CORE ───────────────────────────────────────────────────────────────
 * One pure function — `lightingState(timeOfDay, nightFactor, sunDir?)` — owns
 * the curves. Every renderer becomes a thin READER of its fields.
 * `sunContribution` is a pure function of time/nightFactor (NOT of the frozen
 * sun elevation) that reaches a HARD 0 by deep night, so the warm layers
 * actually die (the gold-night fix). All thresholds are the canonical `T`
 * constants in $lib/utils so Three and Cesium can never drift apart.
 *
 * ─── CONTRACT ───────────────────────────────────────────────────────────────
 * Pure + allocation-free: returns a SHARED module-scope object mutated in place
 * (mirrors the computeSunDirection memo). Read fields synchronously in the same
 * block; never capture the reference across frames. Deterministic by
 * construction (no Math.random) → safe for 3-Pi panorama (invariant #4).
 */

import { T, clamp, lerp, smoothstep, getSkyState, dawnDuskFactor } from '$lib/utils';
import type { SkyState } from '$lib/types';

type Vec3 = [number, number, number];

/**
 * Per-layer × per-phase RGB palette. `blendPhase` crossfades between the four
 * phase colours continuously (no hard switch → no seam). Lives here so the
 * curves are self-contained; consumers (Three layers, shell components)
 * import it directly from this module.
 */
export const SKY_PALETTE = {
	sunCore: {
		dawn:  [1.0, 0.62, 0.28] as Vec3,
		day:   [1.0, 0.94, 0.82] as Vec3,
		dusk:  [1.0, 0.48, 0.18] as Vec3,
		night: [0.8, 0.45, 0.25] as Vec3, // residual twilight tint
	},
	veil: {
		dawn:  [1.00, 0.55, 0.28] as Vec3,
		day:   [0.85, 0.92, 1.00] as Vec3,
		dusk:  [1.00, 0.40, 0.18] as Vec3,
		night: [0.10, 0.18, 0.40] as Vec3,
	},
	ambient: {
		dawn:  [1.00, 0.78, 0.65] as Vec3,
		day:   [0.95, 0.97, 1.00] as Vec3,
		dusk:  [1.00, 0.66, 0.45] as Vec3,
		night: [0.30, 0.40, 0.65] as Vec3,
	},
} as const;

export interface LightingState {
	/** Categorical phase (day | dawn | dusk | night), from the canonical T windows. */
	phase: SkyState;
	/** Warm "golden-hour" hero weight. 0 at full day/night, peaks in the dawn/dusk
	 *  band, eased + capped at 0.75 so dusk never blows out. Consumed ONCE. */
	dawnDuskWeight: number;
	/** How much the sun lights the scene: 1 by day, hard 0 by deep night. Pure
	 *  function of time/nightFactor — the kill-switch for the gold-night warm layers. */
	sunContribution: number;
	/** Visibility curve for the sun-anchored glow layers (SunGlow core/halo,
	 *  EffectStack godrays): a 0.35 daytime plateau with a sine hero-peak through
	 *  the dawn/dusk bands, 0 at night. Owns what sky.ts `sunVisibility` did, now
	 *  on the canonical T windows. */
	sunGlowVisibility: number;
	/** 0 (day) → ~1 (deep night). The single darkening authority for clouds etc. */
	nightDarkness: number;
	/** Discrete city light SOURCES (streetlights, lit windows, the VIIRS
	 *  aggregate + the Three carpet/neon that derive from it) 0..1 — the hard
	 *  lights. On TOGETHER through civil twilight (nf > 0.15). Every discrete
	 *  night-light layer scales by this so they brighten in lock-step. */
	cityLightAmount: number;
	/** Diffuse city SKYGLOW the lights throw into the haze 0..1 — the low-freq
	 *  "vast city below" dome. Builds LATER than cityLightAmount (nf > 0.32):
	 *  the lights come on first, then the glow they cast. */
	cityGlowAmount: number;
	/** Star visibility 0..1, ramps in from late dusk (nf > 0.4). */
	starVisibility: number;
	/** Moon visibility 0..1, ramps in from early dusk (nf > 0.15). */
	moonContribution: number;
	/** Continuous sky/veil colour (no hard phase seam → fixes day banding). */
	skyTint: Vec3;
	/** Continuous warm sun-side / horizon colour. */
	horizonTint: Vec3;
	/** Base ambient tint for the Three environment (env-light). */
	ambientColor: Vec3;
	/** Base ambient intensity (matches the legacy environmentAmbient formula). */
	ambientIntensity: number;
	/** Analytical IBL <Sky> turbidity — lower (clearer/bluer) by day, hazier warm
	 *  at the dawn/dusk horizon. Stops the fixed turbidity from washing out day. */
	skyTurbidity: number;
	/** Analytical IBL <Sky> rayleigh — higher (deeper blue) by day. */
	skyRayleigh: number;
}

// Memo guard so the per-consumer reactive reads (each child calls lightingState
// in its own $derived) collapse to ONE compute per frame: identical inputs →
// return the cached _state without recomputing. Mirrors computeSunDirection's
// memo. `_state` is still the single shared object (read synchronously only).
let _lastT = NaN;
let _lastNf = NaN;
let _lastSunY = NaN;
/** Palette ambient before the horizon boost — the boost re-applies from here. */
const _baseAmbient: [number, number, number] = [0, 0, 0];

// Ambient horizon boost + cool night shift — reproduces the legacy
// environmentAmbient() formula. airMass is derived from the real local sun
// elevation when the caller provides sunElevSin (ThreeOverlay / Clouds do);
// omitted → the legacy sin(0.4) constant keeps old behaviour.
function applyHorizonBoost(sunY: number, nf: number): void {
	_lastSunY = sunY;
	const elev = Math.max(-0.12, Math.min(1, sunY));
	const am = 1.0 / Math.max(0.12, elev + 0.12);
	const horizonBoost = 1 + Math.min(0.8, (am - 1) * 0.25);
	const coolShift = nf * 0.15;
	_state.ambientColor[0] = Math.max(0, _baseAmbient[0] * horizonBoost);
	_state.ambientColor[1] = Math.max(0, _baseAmbient[1] * horizonBoost * (1 - coolShift * 0.6));
	_state.ambientColor[2] = Math.max(
		0,
		_baseAmbient[2] * horizonBoost * (1 - coolShift * 0.4) + coolShift * 0.1
	);
}

// Shared, mutated-in-place return value. Consumers only read.
const _state: LightingState = {
	phase: 'day',
	dawnDuskWeight: 0,
	sunContribution: 1,
	sunGlowVisibility: 0.35,
	nightDarkness: 0,
	cityLightAmount: 0,
	cityGlowAmount: 0,
	starVisibility: 0,
	moonContribution: 0,
	skyTint: [0, 0, 0],
	horizonTint: [0, 0, 0],
	ambientColor: [0, 0, 0],
	ambientIntensity: 0,
	skyTurbidity: 4,
	skyRayleigh: 3,
};

/**
 * Continuous colour blend across night→dawn→day→dusk→night for one palette
 * layer, written into `out`. Each transition window is a two-segment lerp
 * (night→edge→day) so the colour is C0-continuous everywhere — no seam.
 */
function blendPhase(out: Vec3, layer: keyof typeof SKY_PALETTE, t: number): void {
	const P = SKY_PALETTE[layer];
	let a: Vec3 = P.day;
	let b: Vec3 = P.day;
	let u = 0;
	if (t < T.DAWN_START || t >= T.DUSK_END) {
		a = P.night;
		b = P.night;
	} else if (t < T.DAY_START) {
		// Dawn band: night → dawn (first half) → day (second half).
		const x = (t - T.DAWN_START) / (T.DAY_START - T.DAWN_START);
		if (x < 0.5) {
			a = P.night;
			b = P.dawn;
			u = x * 2;
		} else {
			a = P.dawn;
			b = P.day;
			u = (x - 0.5) * 2;
		}
	} else if (t < T.DAY_END) {
		a = P.day;
		b = P.day;
	} else {
		// Dusk band: day → dusk (first half) → night (second half).
		const x = (t - T.DAY_END) / (T.DUSK_END - T.DAY_END);
		if (x < 0.5) {
			a = P.day;
			b = P.dusk;
			u = x * 2;
		} else {
			a = P.dusk;
			b = P.night;
			u = (x - 0.5) * 2;
		}
	}
	out[0] = lerp(a[0], b[0], u);
	out[1] = lerp(a[1], b[1], u);
	out[2] = lerp(a[2], b[2], u);
}

/**
 * Compute the unified lighting state for the current frame.
 *
 * @param timeOfDay   decimal hours 0..24 (model.timeOfDay)
 * @param nightFactor 0..1 darkness (model.nightFactor — already the √-curve SSOT)
 * @param sunElevSin  optional sin(local solar elevation) — world/sky.ts
 *                    `sunElevationSin(latDeg, timeOfDay)`. Feeds ONLY the
 *                    ambient horizon boost; everything phase-related is
 *                    time/nightFactor driven by design. Previously this took a
 *                    sunDir Vec3 and read its [1] — but that component is the
 *                    constant world-polar-axis projection sin(0.4), not a local
 *                    elevation, so the horizon boost was frozen mid-state.
 *                    Callers that omit it get the legacy constant behaviour.
 * @returns the SHARED LightingState — read synchronously, do not capture.
 */
export function lightingState(timeOfDay: number, nightFactor: number, sunElevSin?: number): LightingState {
	const sunY = sunElevSin ?? Math.sin(0.4);
	// Two-stage memo. The palette blend depends on (timeOfDay, nightFactor)
	// only; the horizon boost is three multiplies on top. Keying the whole
	// thing on sunY too meant every caller that omits it (compose, Wing,
	// atmosphere) alternated the key against Clouds/ThreeOverlay and the
	// full blend ran several times per frame.
	if (timeOfDay === _lastT && nightFactor === _lastNf) {
		if (sunY !== _lastSunY) applyHorizonBoost(sunY, clamp(nightFactor, 0, 1));
		return _state;
	}
	_lastT = timeOfDay;
	_lastNf = nightFactor;

	const nf = clamp(nightFactor, 0, 1);

	_state.phase = getSkyState(timeOfDay);

	// Sun-up amount: pure time/nf, hits hard 0 at deep night (nf = 1 at DUSK_END).
	// This is the term that kills the perpetual golden-hour — the warm layers
	// (SunGlow, Veil, LensFlare, cloud Mie) all scale by this.
	_state.sunContribution = clamp(1 - nf, 0, 1);
	_state.nightDarkness = nf;

	// Sun-glow visibility: sine hero-peak through dawn/dusk, 0.35 day plateau,
	// 0 at night. Same shape sky.ts sunVisibility had, re-based on T windows.
	if (timeOfDay >= T.DAWN_START && timeOfDay < T.DAY_START) {
		_state.sunGlowVisibility = Math.sin(((timeOfDay - T.DAWN_START) / (T.DAY_START - T.DAWN_START)) * Math.PI);
	} else if (timeOfDay > T.DAY_END && timeOfDay <= T.DUSK_END) {
		// Dusk phase compressed (x^0.55): the plain sine peaked at 19:30, but
		// the sun-anchored sprites (SunGlow / godrays source) drop below the
		// horizon and get globe-depth-occluded by ~18:45 — the hero peak was
		// landing exactly when nothing could render it. Front-loading the
		// curve puts the glow maximum in the 18:00-18:40 window where the sun
		// is still on the horizon, giving dusk its authored sunset moment.
		// Still 0 at both band edges (x=0, x=1) — no seam.
		const x = (timeOfDay - T.DAY_END) / (T.DUSK_END - T.DAY_END);
		_state.sunGlowVisibility = Math.sin(Math.pow(x, 0.55) * Math.PI);
	} else if (timeOfDay >= T.DAY_START && timeOfDay <= T.DAY_END) {
		_state.sunGlowVisibility = 0.35;
	} else {
		_state.sunGlowVisibility = 0;
	}

	// One warm hero weight, smoothstep-eased and capped so dusk doesn't blow out.
	_state.dawnDuskWeight = Math.min(0.75, smoothstep(dawnDuskFactor(timeOfDay)));

	// City skyglow from EARLY dusk (gate 0.45 → 0.32, evening recalibration):
	// in the real world the city's warm glow rises while the sky still has
	// twilight in it — gating until nf 0.45 left the 18:30-19:30 "evening"
	// band with no warm presence at all once the veil was deleted. Smooth
	// gate still reaches exactly 1 at deep night (nf = 1).
	// Gate raised 0.32 → 0.58 to STAY BEHIND cityLightAmount, which moved to
	// 0.45. The ordering is the contract — lights come on first, then the glow
	// they throw into the haze — and it would have inverted if only one of the
	// pair moved. Glow leading its own source is the giveaway that a night sky
	// was assembled rather than lit.
	//
	// Both ends improve. At dusk the sequence is now lights ~18:36, glow ~18:57,
	// instead of lights at 18:04 — a second past sunset, which was always too
	// eager. At dawn glow clears at ~06:20 just before the lights at ~06:36, so
	// the haze brightens out from under them rather than after them.
	_state.cityGlowAmount = nf <= 0.58 ? 0 : smoothstep((nf - 0.58) / 0.42);

	// Discrete city lights (streetlights, lit windows, the Three carpet + neon
	// that derive from VIIRS) come on TOGETHER through civil twilight — ONE
	// curve so every discrete night-light layer brightens in lock-step instead
	// of each picking its own raw-nf threshold (the carpet used nf-0.2, the
	// neon nf-0.15; they now share this). Gated 0.15, ahead of the diffuse
	// cityGlowAmount above by design: the lights come on first, then the glow
	// they throw into the haze. smoothstep reaches exactly 1 at deep night.
	// ─── GATE RAISED 0.15 → 0.45: LIGHTS MUST GO OUT WITH THE NIGHT ──────────
	// The gate is not just "when do lights come on", it is also "when do they go
	// OUT", and at 0.15 they went out far too late. Both ends read the same
	// nightFactor, but the ground layers floor it at 0.55 while this floored at
	// 0.15, so the two disagreed about when night ended by half an hour:
	//
	//   time   nightFactor   cityLight(old)   VIIRS
	//   06:00     0.707          0.726        0.424
	//   06:30     0.500          0.369        0.000   ← ground daylit, towers lit
	//   06:45     0.354          0.145        0.000
	//   07:00     0.000          0.000        0.000
	//
	// So from ~06:24 the ground was fully daylit while building windows still
	// glowed at up to 37%, for a full half hour. Over Dubai — sunrise ~05:35 in
	// summer — that is broad morning daylight with every tower still lit, which
	// is the single most obvious "this is fake" tell the wall can produce.
	//
	// 0.45 puts the extinguish in step with the ground stack: buildings are down
	// to ~1% by 06:30 instead of 37%.
	//
	// Deep night is UNCHANGED and deliberately so — at nf = 1 this still returns
	// exactly 1.0, so the lit-window look that already reads well keeps its full
	// brightness. Only the twilight schedule tightens.
	_state.cityLightAmount = nf <= 0.45 ? 0 : smoothstep((nf - 0.45) / 0.55);
	// Stars from late dusk; moon a touch earlier.
	_state.starVisibility = clamp((nf - 0.4) * 1.5, 0, 1);
	_state.moonContribution = clamp((nf - 0.15) * 1.18, 0, 1);

	// Continuous palette — no hard phase seam (fixes day banding).
	blendPhase(_state.skyTint, 'veil', timeOfDay);
	blendPhase(_state.horizonTint, 'sunCore', timeOfDay);
	blendPhase(_baseAmbient, 'ambient', timeOfDay);
	applyHorizonBoost(sunY, nf);
	// Intensity floor 0.12 (deep night) → 0.90 (full day). Unchanged from legacy.
	_state.ambientIntensity = 0.12 + (1 - nf) * 0.78;

	// Analytical IBL <Sky> params: clearer + bluer by day (sunContribution → 1),
	// hazier + warmer through the dawn/dusk band so the cubemap matches the
	// palette instead of fighting it. Frozen anyway past nf 0.85 (ThreeOverlay).
	_state.skyTurbidity = lerp(10, 3.2, _state.sunContribution);
	_state.skyRayleigh = lerp(1.4, 3.2, _state.sunContribution);

	return _state;
}
