/**
 * cloud-field — the deterministic cloud population both renderers would draw.
 *
 * WHY THIS EXISTS: aero-1 learned this the expensive way and wrote it down in
 * `clouds/sprite-placement.ts`: when two renderers (or two densities, or two
 * panes of a wall) must draw the SAME sky, the field math has to live in ONE
 * pure module with a pinned RNG draw order — never inline in a component next
 * to WebGL calls where it cannot be tested. aero-2's deck grew inline in
 * `Clouds.svelte` (`emitCluster` + tier counts + weather tables, all
 * untestable behind a canvas) while aero-1's equivalent lives in tested
 * helpers. This module is the merge: aero-2's three-tier/weather design
 * (distant systems, near cumulus that closes in, inverse cirrus veil) with
 * aero-1's contracts (fixed draw sequences, prefix determinism, tested).
 *
 * ─── DRAW ORDER IS PART OF THE CONTRACT ────────────────────────────────────
 * Cluster header draws, always in this order: angle, radius, height,
 * loneliness flip, [spriteCount — ONLY when not lonely], baseScale, shear.
 * Lonely clusters consume 6 draws, full ones 7. Per sprite: position (3 draws
 * for non-anchors, 0 for the anchor), scale (non-anchors only), texture slot
 * (0 draws when the pool holds one texture, else a 0.7 coin plus a second
 * draw off the coin), opacity, rotation, spin rate. Anything that adds,
 * removes, or reorders a draw silently rebuilds the sky on every pane and
 * breaks the prefix tests below — change the order and the tests together.
 *
 * Renderer-free: the output is plain descriptors. `Clouds.svelte` maps them
 * onto Three.js objects.
 *
 * `Weather` is the existing const-array union from `flight/view.js`
 * (type-only import: erased, no runtime edge into the flight model).
 */
import type { Weather } from '../flight/view.js';

/** Tier geometry shared by the builder and the mapper. `as const` objects
 * widened to this so tiers stay interchangeable (distant/near/cirrus differ
 * only in values, never in shape). */
export interface CloudTier {
	readonly radiusMin: number;
	readonly radiusSpan: number;
	readonly scaleMin: number;
	readonly scaleSpan: number;
	readonly spriteMin: number;
	readonly spriteSpan: number;
	readonly lonelyChance: number;
	readonly altOffset: number;
}

/** How much sky each weather fills. Clear stays well below 1: a flight-level
 * window on a clear day is scattered cloud plus a lot of empty sky, and that
 * emptiness is what makes overcast read as weather when it arrives. */
export const WEATHER_COVERAGE: Record<Weather, number> = {
	clear: 0.35,
	cloudy: 1.0,
	rain: 1.25,
	overcast: 1.5,
	storm: 1.65
};

/** Base brightness per weather. Clear deals white texture at 0.9; storm deals
 * smoke at 0.62. Same shape, darker base — a storm cloud is a cumulus with a
 * much darker base, not a paler one repeated. */
export const CLOUD_BRIGHTNESS: Record<Weather, number> = {
	clear: 0.9,
	cloudy: 0.8,
	rain: 0.72,
	overcast: 0.68,
	storm: 0.62
};

/** How far the deck climbs toward the aircraft as weather closes in (0 = sits
 * at the knob altitude, 0.7 = 70% of the way up in a storm). */
export const CLOUD_PROXIMITY: Record<Weather, number> = {
	clear: 0,
	cloudy: 0.25,
	rain: 0.45,
	overcast: 0.6,
	storm: 0.7
};

/**
 * Weather-dealt texture pools, as indices into [white, dark, smoke].
 * Clear never deals smoke; storm never deals clean white.
 */
export const CLOUD_POOLS: Record<Weather, readonly number[]> = {
	clear: [0, 0, 0, 1],
	cloudy: [0, 0, 1, 1],
	rain: [0, 1, 1, 2],
	overcast: [0, 1, 2, 2],
	storm: [1, 1, 2, 2]
};

/** Cirrus is fair-weather ice: white only on clear/cloudy days. */
export const CIRRUS_POOLS: Record<Weather, readonly number[]> = {
	clear: [0],
	cloudy: [0],
	rain: [0, 1],
	overcast: [0, 1],
	storm: [0, 1]
};

/** Tier geometry: [radiusMin, radiusSpan, scaleMin, scaleSpan, spriteMin, spriteSpan, lonelyChance, altOffset]. */
export const DISTANT_TIER = {
	radiusMin: 40_000,
	radiusSpan: 220_000,
	scaleMin: 8_000,
	scaleSpan: 16_000,
	spriteMin: 6,
	spriteSpan: 8,
	lonelyChance: 0.05,
	altOffset: 0
} as const;

export const NEAR_TIER = {
	radiusMin: 2_500,
	radiusSpan: 32_000,
	scaleMin: 2_000,
	scaleSpan: 4_500,
	spriteMin: 4,
	spriteSpan: 6,
	lonelyChance: 0.12,
	altOffset: 0
} as const;

export const CIRRUS_TIER = {
	radiusMin: 40_000,
	radiusSpan: 140_000,
	scaleMin: 12_000,
	scaleSpan: 22_000,
	spriteMin: 3,
	spriteSpan: 5,
	lonelyChance: 0.2,
	altOffset: 3500
} as const;

/** Distant horizon systems: the cheapest tier and the one that says "there is
 * a sky out there". Floors at 1 — an empty sky where cloud belongs reads as
 * broken, not as clear weather. */
export function distantCountFor(density: number, qualityScale: number, coverage: number): number {
	return Math.max(1, Math.round((12 + density * 26) * qualityScale * coverage));
}

/** Near cumulus takes the strongest weather multiplier: cloud at 2–30 km is
 * the storm you are flying through, distant cloud is scenery. */
export function nearCountFor(density: number, qualityScale: number, coverage: number): number {
	return Math.max(1, Math.round((7 + density * 15) * qualityScale * (1 + (coverage - 1) * 1.25)));
}

/** Cirrus thins as the deck thickens: under a storm you are below it and
 * cannot see it at all. An overcast lid, not more of everything. */
export function cirrusCountFor(density: number, qualityScale: number, coverage: number): number {
	return Math.max(
		1,
		Math.round((6 + density * 9) * qualityScale * (coverage > 1 ? 1 / coverage : 1))
	);
}

export interface CloudSpriteDesc {
	ox: number;
	oy: number;
	oz: number;
	sprScale: number;
	/** Index into the weather's texture pool (not into the texture list). */
	texSlot: number;
	brightness: number;
	opacity: number;
	rotation: number;
	rotSpeed: number;
}

/** Which tier dealt this cluster: 0 distant, 1 near, 2 cirrus. The mapper
 * needs it because cirrus draws from its own texture pool. */
export type CloudTierId = 0 | 1 | 2;

export interface CloudClusterDesc {
	sprites: CloudSpriteDesc[];
	shear: number;
	tier: CloudTierId;
	/** Cluster centre — sprites[0] (the anchor) sits exactly here. */
	cx: number;
	ch: number;
	cz: number;
}

export interface CloudFieldParams {
	rand: () => number;
	weather: Weather;
	brightBase: number;
	nearRadius: number;
	distantCount: number;
	nearCount: number;
	cirrusCount: number;
}

/**
 * Pick a texture slot from a pool with a 0.7 bias toward the pool's head
 * (the weather's dominant texture). Single-texture pools consume NO draw —
 * `1 + floor(rand() * (len - 1))` is index 1 whenever the list holds one
 * texture, which once built cirrus sprites with `map: undefined`: flat grey
 * cards in the sky. The length guard is load-bearing, not tidy.
 */
export function pickTexSlot(poolLength: number, rand: () => number): number {
	if (poolLength < 2) return 0;
	return rand() < 0.7 ? 0 : 1 + Math.floor(rand() * (poolLength - 1));
}

function drawClusterSprites(
	rand: () => number,
	pool: readonly number[],
	cx: number,
	ch: number,
	cz: number,
	baseScale: number,
	spriteCount: number,
	bright: number,
	out: CloudSpriteDesc[]
): void {
	for (let i = 0; i < spriteCount; i++) {
		// Anchor sprite sits at the cluster centre: guaranteed bright core,
		// the rest accumulate outward. Anchors draw nothing for position.
		let ox = cx;
		let oy = ch;
		let oz = cz;
		if (i > 0) {
			const theta = rand() * Math.PI * 2;
			const r = (0.2 + rand() * 0.8) * baseScale * 1.6;
			ox += Math.cos(theta) * r;
			oz += Math.sin(theta) * r;
			oy += (rand() - 0.5) * (baseScale * 0.35);
		}

		// Anchors are 1.25x with no draw; the scale draw belongs to the
		// non-anchors at exactly this point in the sequence.
		const sprScale = baseScale * (i === 0 ? 1.25 : 0.85 + rand() * 0.55);
		const texSlot = pickTexSlot(pool.length, rand);

		// Underside gradient off the weather's base: clear starts white,
		// storm starts dark. No draws — pure function of placed geometry.
		const yNorm = (oy - ch + baseScale * 0.1) / (baseScale * 0.2);
		const yClamp = Math.max(0, Math.min(1, yNorm));
		const ySoft = yClamp * yClamp * (3 - 2 * yClamp);
		const brightness = bright + ySoft * 0.1;
		const opacity = 0.34 + rand() * 0.3;

		out.push({
			ox,
			oy,
			oz,
			sprScale,
			texSlot,
			brightness,
			opacity,
			rotation: rand() * Math.PI * 2,
			rotSpeed: (rand() - 0.5) * 0.05
		});
	}
}

function drawCluster(
	rand: () => number,
	pool: readonly number[],
	tier: CloudTier,
	radiusScale: number,
	bright: number,
	tierId: CloudTierId
): CloudClusterDesc {
	const angle = rand() * Math.PI * 2;
	const dist = tier.radiusMin * radiusScale + Math.sqrt(rand()) * tier.radiusSpan * radiusScale;
	const cx = Math.cos(angle) * dist;
	const cz = Math.sin(angle) * dist;
	const ch = tier.altOffset + (rand() - 0.5) * 800;

	const isLonely = rand() < tier.lonelyChance;
	// Conditional draw: lonely clusters consume 6 header draws, full ones 7.
	// The branch is the loneliness flip and nothing else — see module header.
	const spriteCount = isLonely ? 1 : tier.spriteMin + Math.floor(rand() * tier.spriteSpan);
	const baseScale = tier.scaleMin + rand() * tier.scaleSpan;
	const shear = (rand() - 0.5) * 0.25;

	const sprites: CloudSpriteDesc[] = [];
	drawClusterSprites(rand, pool, cx, ch, cz, baseScale, spriteCount, bright, sprites);
	return { sprites, shear, tier: tierId, cx, ch, cz };
}

/**
 * Build the whole deck population on one shared stream: distant, then near,
 * then cirrus. Lower coverage emits FEWER clusters per tier off the same
 * stream, so each tier is a strict prefix of a heavier sky — the same seam
 * contract aero-1 pins in `cluster-budget.test.ts`.
 */
export function buildCloudField(params: CloudFieldParams): CloudClusterDesc[] {
	const { rand, weather, brightBase, nearRadius } = params;
	const pool = CLOUD_POOLS[weather] ?? CLOUD_POOLS.clear;
	const cirrusPool = CIRRUS_POOLS[weather] ?? CIRRUS_POOLS.clear;
	const out: CloudClusterDesc[] = [];
	for (let c = 0; c < params.distantCount; c++) {
		out.push(drawCluster(rand, pool, DISTANT_TIER, 1, brightBase, 0));
	}
	for (let c = 0; c < params.nearCount; c++) {
		out.push(drawCluster(rand, pool, NEAR_TIER, nearRadius, brightBase, 1));
	}
	for (let c = 0; c < params.cirrusCount; c++) {
		out.push(drawCluster(rand, cirrusPool, CIRRUS_TIER, 1, brightBase, 2));
	}
	return out;
}
