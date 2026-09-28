/**
 * Night palette — authored sky-state targets for the Cesium scene.
 *
 * Up until now, every night tunable lived inline in world/compose.ts as
 * a literal number inside a lerp() call. Editing the dawn warmth meant
 * hunting through a 200-line tick function for `dd * 0.15`. Now the
 * targets live here, grouped by what they DO, and compose.ts becomes a
 * reader of NIGHT_PALETTE.
 *
 * Compose pattern across the board:
 *
 *     value = lerp(P.day, P.night, nightFactor)
 *           + (dawnDuskFactor * P.duskBias)   -- additive bias at dusk peak
 *
 * Or, when the dusk bias is multiplicative (globeColor):
 *
 *     value = lerp(lerp(P.day, P.night, nf), P.duskBias, dd * P.duskWeight)
 *
 * Both shapes match the existing compose.ts math — this is a relocation
 * of authoring data, not a re-tuning. To re-tune the night look, edit
 * the numbers in this file.
 *
 * Why under content/ and not lib/world/: these are AESTHETIC targets a
 * curator could legitimately change. The math that consumes them is
 * engine code and stays in lib/world/.
 */

/**
 * ─── THE NIGHT SKY TUNING SURFACE (read me) ──────────────────────────────────
 *
 * The ENTIRE night pipeline is a function of `nightFactor(timeOfDay)`
 * (see src/lib/utils.ts). Every Cesium dim (skyAtmosphere brightnessShift,
 * exposure, atmosphereLight, fog, baseColor, VIIRS, color-grade shader)
 * AND every Three.js dim (ambient floor, cloud nightDark, moon visibility)
 * lerps off it. Reshape that ONE function and the whole composition shifts.
 *
 * Master curve (most impactful):
 *   - `nightFactor` uses a √t concave curve so 30 min after sunset the sky
 *     is already ~40% dim, 60 min in is ~60%, 90 min in is ~80%. Linear
 *     ramp left evening hours mathematically half-bright.
 *   - `T.DEEP_NIGHT` (utils.ts) — when nf hits 1.0. Currently 21:00.
 *
 * Per-layer targets (this file):
 *   - `skyAtmosphere.brShift/satShift` — Cesium analytical sky look at night
 *     (clamped at Cesium's -1.0 internal floor)
 *   - `globeColor` — color of unrendered globe (where imagery has gaps)
 *   - `viirs` — Black Marble night-light overlay opacity ceiling
 *   - `scene.exposureDay` / `scene.atmosphereLightDay` — day anchors;
 *     night targets are operator-tunable in config-tree (world.nightExposure,
 *     world.atmosphereLight, world.skyDarken)
 *
 * Operator sliders (config-tree, also surfaced in admin panel):
 *   - `world.nightExposure` — global Cesium tonemap dim at deep night
 *   - `world.atmosphereLight` — atmosphere bleed onto ground at deep night
 *   - `world.skyDarken` — multiplier on `brShift` toward Cesium's -1 clamp
 *
 * Three.js overlay layers (separate transparent canvas, not in this pipeline):
 *   tuned in src/lib/world/sky.ts + src/lib/world/three/Clouds.svelte.
 *
 * To darken night sky: edit the √-curve exponent in utils.ts FIRST (fixes
 * everything via single point of truth), then lower the operator sliders if
 * still too bright at deep night.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export const NIGHT_PALETTE = {
	/**
	 * Cesium globe baseColor (uint8 RGB). Lerps day → night with nightFactor,
	 * then biases toward duskBias proportional to dawnDuskFactor × duskWeight.
	 *
	 * Past attempts: dd=0.3 gave a "brownish globe" at dusk peak. dd=0.15 is
	 * the sweet spot — warm influence without the mud.
	 */
	globeColor: {
		day:       [140, 170, 200] as const,
		night:     [25, 25, 40]    as const,
		duskBias:  [110, 90, 80]   as const,
		// 0.15 → 0.22 (P3 recalibration): with the Three-side AtmosphericVeil
		// deleted, Cesium owns dusk alone — the globe needed more of the warm
		// scatter the veil used to contribute. Still well under the 0.3 that
		// produced the "brownish globe".
		duskWeight: 0.22,
	},

	/**
	 * scene.skyAtmosphere shift uniforms. brShift is also multiplied by
	 * world.skyDarken (operator knob) at consume site.
	 *
	 * Past attempts: satShift dd contribution was -0.5 (killed Cesium's warm
	 * sunset scatter). -0.08 retains warmth while cancelling cyan edge.
	 */
	skyAtmosphere: {
		// satShift -1 keeps the night sky fully greyscale (eliminates
		// the cyan limb the desat-only Hosek-Wilkie was producing).
		// brShift base set to -0.4 so the operator knob `world.skyDarken`
		// (default 2.4) lands at effective -0.96 — just under Cesium's
		// -1.0 clamp, so the knob still has visible headroom in both
		// directions. (Going lower than -0.4 here saturates the clamp and
		// the knob becomes inert.) The bulk of night sky dimming now
		// comes from world.nightExposure post-process exposure.
		// duskBias flipped POSITIVE (P3 recalibration, post-veil-deletion):
		// the nf-lerp toward night:-1.0 was already at satShift ≈ -0.64 /
		// brShift ≈ -0.43 (×skyDarken) by 19:00 — the dusk sky rendered
		// near-black grey, no amber arc. The positive bias re-saturates +
		// re-brightens the Cesium sunset scatter at the dusk PEAK only
		// (dd → 0 by 21:00, so deep night still lands exactly on the -1.0
		// greyscale target — the cyan-limb fix is untouched).
		satShift: { day: 0, night: -1.0, duskBias: 0.35 },
		brShift:  { day: 0, night: -0.4, duskBias: 0.22 },
	},

	/**
	 * scene.postProcessStages.exposure + globe.atmosphereLightIntensity.
	 * Day values are Cesium defaults; night targets are operator-tunable via
	 * world.nightExposure / world.atmosphereLight so we read those at runtime.
	 */
	scene: {
		// 1.0 → 1.4 (visual review, Aug 2026): ACES tonemapping compresses the
		// LDR satellite imagery hard, so exposure 1.0 rendered mid-afternoon
		// like late dusk. Night is unaffected — exposure lerps toward the
		// operator-tunable world.nightExposure by nightFactor.
		//
		// 1.4 → 1.7 (Aug 2026): still read dim on the fielded panels. The room
		// is the reason the first correction was not enough — these are matte
		// portrait screens in a daylit office, competing with ambient light no
		// darkened review monitor has. ACES rolls the top off, so this is ~+21%
		// of scene luminance in but well under that on screen, and highlights
		// compress rather than clip. Night still unaffected (nightFactor lerp).
		//
		// 1.7 → 2.2 (Sep 2026): the fielded wall still read dim by day. The
		// Narkowicz ACES shoulder is why +0.3 steps vanished on screen — at
		// the imagery midtone (~0.23 linear) 1.4/1.7/2.0 land at 0.47/0.53/
		// 0.59 linear, so each bump was worth ~3% of sRGB. 2.2 is a step you
		// can see; bright sand (~0.65 linear) compresses to ~0.93 sRGB, not
		// clipped. NOT a tonemapper swap: Cesium runs tonemapping BEFORE the
		// custom stages, so PBR_NEUTRAL/FILMIC would re-feed the night palette
		// pass — that is a full night re-tune, not a day fix.
		exposureDay:        2.2,
		/** globe.lambertDiffuseMultiplier by day (Cesium default 0.9 at night) —
		 *  see syncAtmosphere. Holds the ground on its lit clamp through the
		 *  afternoon instead of sagging from ~13:30. */
		lambertDay:         1.4,
		atmosphereLightDay: 10.0,
	},

	/**
	 * VIIRS Black Marble alpha ceiling at deep night. The NASA tiles paint
	 * a uniform amber wash at 1.0 — capping keeps them reading as
	 * "lit terrain" on top of the shader-darkened base. Previously lived
	 * in $lib/night/index.ts; consolidating into the palette so all night
	 * targets sit in one file.
	 *
	 * ─── ⚠ THIS CEILING WAS UNENFORCED UNTIL 2026-08 ────────────────────
	 * imagery.ts clamped the composed alpha to 1.0 rather than to this value,
	 * and the operator gain (0..5) multiplied into it, so the product hit 5.6
	 * and pinned the layer fully opaque — the exact "uniform amber wash" the
	 * cap exists to prevent. syncImagery now clamps to maxAlpha.
	 *
	 * NOTE the prose above previously said "capping at 0.5" while the value
	 * has been 0.8. Enforcement was written against the VALUE (0.8).
	 *
	 * Both settings were then MEASURED on the production build rather than
	 * argued from the comment, and 0.5 is meaningfully darker:
	 *
	 *              Chicago lit%    Dubai mean lum
	 *   0.8 (now)      55.5             92.6
	 *   0.5            8.8              61.9
	 *
	 * So the knob works and is the right one to reach for — but in the darker
	 * direction. Given the display was reported as too dim, 0.8 stays. Drop to
	 * 0.5 only if the deep-night VIIRS wash ever reads too STRONG.
	 */
	/**
	 * VIIRS night-lights fill (not structure).
	 *
	 * viirsLayerAlpha = maxAlpha × ease × gain × altGate × boost, then clamp
	 * to maxAlpha. Keep world.viirsAlphaBoost ≈ 1.0 so altGate stays live
	 * (boost > ~1.03 re-pins the product — see imagery.ts). Scale 5 → gain 1
	 * is the shipped night-show band; structure comes from building windows
	 * and the z18 road mask. VIIRS is "where is the city" fill only.
	 *
	 * 0.6 → 0.30 → 0.20 → 0.14: zoom-8 VIIRS is ~583 m/px; at 30k ft one
	 * sample spans ~88 screen px. It cannot resolve roads/buildings — only a
	 * soft city blob. Lower ceiling = less "soaky" amber puddle; roads carry
	 * the city, VIIRS only seeds where light is (mask + faint halo).
	 */
	viirs: {
		// 0.20 → 0.15 (2026-08 de-soak). Structure = vector road lamps + buildings.
		// Street brightness follows VIIRS at runtime (roads-geojson × viirs-field);
		// the optional viirs-roads tile bake is legacy cache only.
		maxAlpha:         0.15,
		smoothstepFloor:  0.55,
		smoothstepCeil:   0.9,
		// Fraction of the altitude gate that survives at ground level. The
		// gate (1 − altitudeDetailMix) fades VIIRS to ZERO by 5k ft — right
		// where flyover beats live — leaving low-altitude night terrain a
		// black void punctured only by roads and windows. A 0.25 floor keeps
		// a dim city-glow halo under the (now correctly ordered) road mask:
		// roads carry structure, VIIRS carries the pooled-light halo — the
		// "VIIRS mask over the streets" read. Subtle enough that the
		// 583 m/px blur doesn't come back as a wash.
		lowAltFloor:      0.25,
	},
} as const;
