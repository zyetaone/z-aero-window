/**
 * Vector night roads — the licence-clean replacement for the CartoDB raster.
 *
 * The street grid is what makes a night city read as a city; VIIRS alone is a
 * soft blob. That grid came from `basemaps.cartocdn.com/dark_nolabels`, whose
 * terms put it behind CARTO Enterprise for commercial use — and 132 MB of the
 * 139 MB packaged tile cache was CARTO-derived (raw `cartodb-dark` plus the
 * baked `viirs-roads` composite built from it).
 *
 * The same geometry already sits in `data/roads/<city>.geojson`: OSM under
 * ODbL, ~48 MB for all eight cities (per-class radii up to 40 km for
 * arterials) — still far smaller than the tile cache it replaced, and it
 * reaches the fleet because `git pull` IS the deploy mechanism.
 *
 * The night CURVE is not re-derived here. `roadMaskAlpha()` stays in imagery.ts
 * and is imported verbatim. VIIRS luminance per segment (`viirs-glow.ts` +
 * `viirs-field`) gates lamp brightness so streets bloom only inside lit cores.
 *
 * This was proposed and reverted twice before (fe043a0) on two objections, both
 * now stale: it needed a runtime Overpass call (the data is pre-baked and served
 * by /api/roads/:city), and it drew dots (that was a point-primitive attempt;
 * these are polylines).
 */
import type * as CesiumType from 'cesium';
import { groundAltM, LOCATION_MAP } from '$content/locations';
import type { LocationId } from '$lib/types';
import { altitudeDetailMix } from '$lib/world/altitude';
import { clamp } from '$lib/utils';
import { roadMaskAlpha } from '$lib/world/imagery';
import {
	viirsGlowBucketCenter,
	viirsGlowBucketIndex,
	viirsRoadGlowScale,
	VIIRS_ROAD_GLOW_FLOOR,
} from '$lib/world/viirs-glow';
import { awaitViirsField, getViirsField, type ViirsField } from '$lib/world/viirs-field';
import { EpsilonGate } from './util';
import { registerViewerTeardown } from './viewer-lifecycle';

/** OSM highway classes the packager emits, brightest/widest first. */
export const ROAD_CLASSES = [
	'motorway',
	'trunk',
	'primary',
	'secondary',
	'tertiary',
	'residential',
] as const;
export type RoadClass = (typeof ROAD_CLASSES)[number];

const ROAD_CLASS_SET = new Set<string>(ROAD_CLASSES);

/**
 * Per-class width (screen pixels) and alpha weight.
 *
 * ⚠ THESE ARE THE CALIBRATION KNOB — polyline width is CONSTANT SCREEN SPACE.
 * Unlike the raster it replaces, a line does not attenuate with altitude: the
 * same stroke that reads as an artery at 5,000 ft is moiré at 34,000 ft, where
 * 2,749 of Hyderabad's 3,447 features are `residential` alone. Tune at the
 * night-show band (~28,000 ft, see nightAltitude in the catalogue), not on a
 * desk at ground level.
 */
const ROAD_STYLE: Record<RoadClass, { width: number; alpha: number; glowScale: number }> = {
	// ⚠ ARTERY GLOW IS SPREAD, NOT BRIGHTNESS. glowScale multiplies
	// PolylineGlow's glowPower, where HIGHER = wider, softer halo. At 1.6 the
	// motorway halo (0.22 × 1.6 = 0.35) bled into its neighbours and the trunk
	// network read as filled AREAS rather than lit lines. Tightened toward a
	// brighter core; alpha eased in step so the arteries read as intense
	// rather than as flood.
	//
	// alpha has a HARD FLOOR: roads-geojson.test asserts motorway stays above
	// 0.2 through the whole night band, a number verified in real-GPU frames
	// over Hyderabad at 30,000 ft. The shipped curve lands ~0.27, so there is
	// only ~25% of headroom here — do not cut these further without re-flying it.
	motorway: { width: 4.5, alpha: 0.88, glowScale: 1.25 },
	trunk: { width: 4.0, alpha: 0.84, glowScale: 1.2 },
	primary: { width: 3.4, alpha: 0.76, glowScale: 1.15 },
	secondary: { width: 2.6, alpha: 0.62, glowScale: 1.1 },
	tertiary: { width: 2.2, alpha: 0.45, glowScale: 1.0 },
	// The bulk of the features and the moire risk. Additionally faded by
	// altitudeDetailMix at draw time — see roadClassAlpha.
	residential: { width: 1.8, alpha: 0.3, glowScale: 0.9 },
};

/**
 * Lift above the city ground, in metres.
 *
 * A line drawn exactly at terrain height z-fights it into a dashed shimmer.
 * ponytail: a constant lift, not draping. Ceiling — at grazing angles over
 * real relief the line can still clip into a hillside; the upgrade path is
 * GroundPolylinePrimitive, which drapes properly but costs a terrain-shadow
 * pass the Pi 5 does not have to spare.
 */
const ROAD_LIFT_M = 8;

/** A road ready to hand to Cesium: flat lon/lat pairs + its class. */
export interface RoadPolyline {
	/** Flattened [lon, lat, lon, lat, …] in degrees. */
	coords: number[];
	/** Altitude in metres AMSL (city ground × exaggeration, plus the lift). */
	altM: number;
	cls: RoadClass;
}

/**
 * GeoJSON FeatureCollection → polylines, in metres AMSL.
 *
 * Same ground-offset contract as buildings-geojson: `groundAltM` is what keeps
 * Denver's grid out of the mountain rather than 1,600 m underneath it, and
 * `exaggeration` mirrors scene.verticalExaggeration, which scales TERRAIN but
 * not primitives. Both failures are silent — no error, just no grid.
 *
 * Pure and exported so both can be asserted without a GPU.
 */
export function polylinesFromGeojson(
	geojson: unknown,
	locationId: LocationId,
	exaggeration = 1,
): RoadPolyline[] {
	const fc = geojson as { features?: unknown };
	if (!Array.isArray(fc?.features)) return [];

	const alt =
		groundAltM(locationId) * (Number.isFinite(exaggeration) ? exaggeration : 1) + ROAD_LIFT_M;
	const out: RoadPolyline[] = [];

	for (const raw of fc.features) {
		const f = raw as {
			geometry?: { type?: string; coordinates?: unknown };
			properties?: { class?: unknown };
		};
		if (f?.geometry?.type !== 'LineString') continue;
		const pts = f.geometry.coordinates;
		if (!Array.isArray(pts) || pts.length < 2) continue;

		const coords: number[] = [];
		for (const pt of pts) {
			if (!Array.isArray(pt) || pt.length < 2) continue;
			const [lon, lat] = pt as number[];
			if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
			if (lon < -180 || lon > 180 || lat < -90 || lat > 90) continue;
			// Drop repeated vertices: PolylineGeometry collapses a run of
			// duplicates to nothing and returns undefined, which surfaces as a
			// missing road rather than an error.
			const n = coords.length;
			if (n >= 2 && coords[n - 2] === lon && coords[n - 1] === lat) continue;
			coords.push(lon, lat);
		}
		// Two distinct vertices minimum to make a segment.
		if (coords.length < 4) continue;

		// Unknown or missing class is styled as residential rather than dropped:
		// a road the packager tagged in a way we did not anticipate should still
		// light up, just quietly. Total by construction — nothing is skipped.
		const c = f.properties?.class;
		const cls: RoadClass =
			typeof c === 'string' && ROAD_CLASS_SET.has(c) ? (c as RoadClass) : 'residential';

		out.push({ coords, altM: alt, cls });
	}
	return out;
}

/**
 * Below this a bin is hidden outright rather than drawn transparently.
 *
 * Not a rendering nicety — the dominant cost control for this layer. See the
 * comment at the show= assignment in syncOfflineRoads. Chosen well under what
 * is perceptible against the graded night ground, so nothing visibly pops:
 * roadClassAlpha crosses it smoothly as altitude changes.
 */
const MIN_VISIBLE_ALPHA = 0.02;

/**
 * ⚠ roadMaskAlpha's RANGE WAS CHECKED AGAINST THIS RENDERER AND IT HOLDS.
 *
 * The mask was calibrated for a raster imagery layer, so the obvious worry is
 * that its absolute range is wrong for polylines: at the shipped
 * nightLightScale of 2.0 nightLightGain caps it at 0.40, and the altitude gate
 * drags it to 0.267 by 30,000 ft — the night-show band for most of the
 * catalogue. A brief detour added a 2.6x "vector gain" to compensate.
 *
 * That was a misdiagnosis, and the record is here so nobody repeats it. The
 * frame that looked like a vanished grid was a CAMERA AIM artifact: at 30,000
 * ft with a -49.5 deg pitch the look-at point lands ~7.8 km ahead, which is
 * past the edge of a ~7 km road extract. Re-aimed at the extract, the mask's
 * own numbers render a fully legible city, and the 2.6x gain blew the arteries
 * into fat white ribbons that read as a printed road map.
 *
 * So: no gain. roadMaskAlpha stays the single source of truth for "how lit is
 * the ground right now", and this layer only applies per-class weighting on
 * top. If a future frame really does look under-lit, re-verify the camera is
 * inside the extract BEFORE touching the curve.
 */

/**
 * Final per-class alpha for one frame.
 *
 * `base` is roadMaskAlpha() — imported, not reimplemented. Residential is the
 * only class that additionally tracks altitudeDetailMix: it is 80% of the
 * feature count, and at cruise it is the difference between a legible grid and
 * a grey haze of aliased 1-px lines.
 *
 * Pure so the altitude behaviour is assertable without a GPU.
 */
export function roadClassAlpha(cls: RoadClass, base: number, altitudeFt: number): number {
	const w = ROAD_STYLE[cls].alpha;
	const detail = cls === 'residential' ? altitudeDetailMix(altitudeFt) : 1;
	return clamp(base * w * detail, 0, 1);
}

/**
 * Street-lamp types, as a small fixed palette rather than a colour per road.
 *
 * A real city is not lit in one colour: sodium vapour dominates older Indian
 * and US arterials, LED retrofits read cold blue-white, and the mixed
 * commercial stuff sits between. Painting every road `#ffd9a0` is what made the
 * first frames read as daytime road casing rather than lit streets.
 *
 * THREE bins, not per-road colours, is the whole trick: each bin is one
 * PolylineCollection with one shared Material, so colour variety costs a
 * handful of extra draw batches instead of thousands of materials.
 */
export const ROAD_LAMPS = [
	// ⚠ SATURATED ON PURPOSE. These are read through the night colour-grade
	// post-process, which desaturates hard — the first pass used #ffd9a0 and
	// came out of the grade as plain white, reading as daytime road casing
	// rather than lit streets. Judge these in a graded frame, never from the hex.
	{ css: '#ff6a00', glow: 0.22 }, // sodium vapour — the dominant warm orange
	{ css: '#ffa62e', glow: 0.18 }, // mixed / older warm white
	{ css: '#8fb8ff', glow: 0.14 }, // LED retrofit — cold, and deliberately dimmest
] as const;

/** Rough real-world mix: sodium still wins, LED is the minority retrofit. */
const LAMP_WEIGHTS = [0, 0, 0, 1, 1, 2] as const;

/**
 * Which lamp lights this road.
 *
 * ⚠ DETERMINISTIC, AND THAT IS A FLEET REQUIREMENT, NOT A STYLE CHOICE.
 * Three Pis render three slices of ONE continuous window. Anything rolled with
 * Math.random() diverges between them, so the same street is orange on the left
 * screen and blue on the middle one. This is a pure hash of the road's own
 * first vertex, so every device independently reaches the same answer with
 * nothing to broadcast. Same lesson as the ambient-jitter desync.
 *
 * Pure and exported so the determinism is assertable without a GPU.
 */
export function roadLampIndex(coords: number[]): number {
	// Cheap integer hash over the first vertex at ~1 m resolution. Rounded so
	// float noise in the extract cannot flip a road between bins.
	const a = Math.round(coords[0] * 1e5);
	const b = Math.round(coords[1] * 1e5);
	let h = (a ^ (b << 1)) >>> 0;
	h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
	h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
	h = (h ^ (h >>> 15)) >>> 0;
	return LAMP_WEIGHTS[h % LAMP_WEIGHTS.length];
}

/**
 * Slight per-bin brightness wander, so the grid breathes instead of sitting
 * dead flat.
 *
 * Real street lighting is never uniform — lamps age, some are out, mains
 * voltage sags. A few percent is the whole budget here: at more than that it
 * reads as a rendering bug rather than as a city.
 *
 * ⚠ DRIVEN BY timeOfDay, NOT a local frame counter or Math.random.
 * Same fleet-sync reason as roadLampIndex: timeOfDay is already synchronised
 * across the three Pis, so a pure function of it flickers identically on all
 * three. A locally-accumulated dt would drift them apart within minutes.
 *
 * ponytail: one sine per bin, no per-lamp simulation. Ceiling — every road in
 * a bin breathes together; per-road flicker would need per-road materials,
 * which is the thing the bin design exists to avoid.
 */
/**
 * Phase offset for one (class x lamp) bin.
 *
 * ⚠ DERIVED FROM THE BIN'S IDENTITY, NEVER ITS INSERTION ORDER.
 * This was `bins.size` at construction, which is order-dependent: bins are
 * created in whatever order the features happen to arrive, so any difference in
 * parse order between the three Pis would give the same bin a different phase
 * and the wall would breathe out of step. Same class of bug as seeding colour
 * from a counter instead of the coordinates — it looks deterministic in a
 * single-process test and desyncs in the field.
 *
 * Pure and exported so the order-independence is assertable.
 */
export function roadBinPhase(cls: RoadClass, lamp: number): number {
	return ROAD_CLASSES.indexOf(cls) * ROAD_LAMPS.length + lamp;
}

/** Lamp breathing, ±4 %. Pure in the wall second: three panes, one phase. */
export function roadFlicker(binPhase: number, wallSec: number): number {
	return 1 + 0.04 * Math.sin(wallSec * 0.7 + binPhase * 2.399963);
}

/**
 * Lon/lat at the polyline midpoint — better VIIRS sample than an endpoint for
 * long segments that cross dark → lit belts. Pure and fleet-safe.
 */
export function roadViirsSamplePoint(coords: number[]): { lat: number; lon: number } {
	if (coords.length < 4) return { lon: coords[0] ?? 0, lat: coords[1] ?? 0 };
	const mid = (Math.floor(coords.length / 4) * 2) | 0;
	return { lon: coords[mid], lat: coords[mid + 1] };
}

/**
 * VIIRS luminance at a road's midpoint → lamp scale. Pure, fleet-safe.
 *
 * Vector roads replace the baked `viirs-roads` raster: the same glow curve
 * (`viirs-glow.ts`) runs at load time via `viirs-field` sampling so lamps
 * only bloom inside real lit areas, with a floor in sparse suburbs.
 */
export function roadViirsScaleForPolyline(
	coords: number[],
	field: ViirsField | null,
	floor = VIIRS_ROAD_GLOW_FLOOR,
): number {
	if (coords.length < 2) return viirsGlowBucketCenter(viirsGlowBucketIndex(floor, floor), floor);
	if (!field) {
		// Field still loading or failed — mid-scale fallback, not full bright.
		return viirsGlowBucketCenter(Math.floor(viirsGlowBucketIndex(1, floor) / 2), floor);
	}
	const { lat, lon } = roadViirsSamplePoint(coords);
	return viirsRoadGlowScale(field.sampleBilinear(lat, lon), floor);
}

// ─── Rendering ──────────────────────────────────────────────────────────────

interface RoadBin {
	/**
	 * Either a draped GroundPolylinePrimitive (preferred — follows terrain) or
	 * a PolylineCollection at a fixed altitude (fallback). Both expose `show`,
	 * which is all the per-frame path needs.
	 */
	lines: { show: boolean };
	material: CesiumType.Material;
	cls: RoadClass;
	/** VIIRS-modulated lamp scale [floor, 1] — streets dim in dark outskirts. */
	viirsScale: number;
	/** Stable phase offset so bins do not all breathe in lockstep. */
	phase: number;
	/** Same idempotency pattern every sibling subsystem uses for uniform writes. */
	alpha: EpsilonGate<number>;
	/** Roads collected during parse, consumed once when the bin is realised. */
	pending: RoadPolyline[];
}

interface CityRoads {
	/**
	 * One collection per (class x lamp x viirs-bucket) bin — at most ~144, typically ~30.
	 */
	bins: Map<string, RoadBin>;
	/** How this city's bins were realised — needed to remove from the right scene bucket. */
	draped: boolean;
}

/**
 * One cached entry per city, never destroyed once built — same reasoning as
 * buildings-geojson: eight fixed locations forever, and the operator asked that
 * geometry stop vanishing mid-flight.
 */
const _cityRoads = new Map<LocationId, CityRoads>();

/** Cities whose VIIRS sample used the mid fallback — re-bin when the field arrives. */
const _cityViirsFallback = new Set<LocationId>();

/** In-flight loads, so a rapid hop sequence can't request the same city twice. */
const _inFlight = new Map<LocationId, Promise<void>>();

/** In-flight VIIRS refresh jobs — one per city. */
const _viirsRefresh = new Map<LocationId, Promise<void>>();

let _cs: typeof CesiumType | null = null;
let _viewer: CesiumType.Viewer | null = null;

/** True when this layer has anything to show for `id`. */
export function hasOfflineRoads(id: LocationId): boolean {
	return _cityRoads.has(id);
}

/**
 * Drop all cached collections. MUST run on every viewer (re)mount.
 *
 * The remount trap this repo has now hit five times (tileset, imagery layers,
 * EpsilonGates, offline buildings, and this): the map is a module singleton but
 * the VIEWER is not, so after a Cesium auto-retry / HMR / page nav every cached
 * collection belongs to a destroyed scene while hasOfflineRoads() still reports
 * the city as loaded — the loader early-returns, nothing joins the new scene,
 * and the grid is gone until a full reload.
 *
 * Clearing is enough: viewer.destroy() takes its own primitives with it.
 */
export function resetOfflineRoads(): void {
	// Clearing the maps drops the gates with the bins they belong to, so there
	// is no separate gate reset to forget — the EpsilonGate remount trap that
	// bit imagery.ts cannot recur here by construction.
	_cityRoads.clear();
	_inFlight.clear();
	_cityViirsFallback.clear();
	_viirsRefresh.clear();
}

function destroyCityRoads(locationId: LocationId): void {
	const city = _cityRoads.get(locationId);
	const viewer = _viewer;
	const C = _cs;
	if (!city || !viewer || !C) return;
	for (const bin of city.bins.values()) {
		if (city.draped) {
			viewer.scene.groundPrimitives.remove(bin.lines as CesiumType.GroundPolylinePrimitive);
		} else {
			viewer.scene.primitives.remove(bin.lines as CesiumType.PolylineCollection);
		}
	}
	_cityRoads.delete(locationId);
	_cityViirsFallback.delete(locationId);
}

/**
 * Re-load a city when VIIRS was unavailable on the first bake. Cheap: only runs
 * for cities in `_cityViirsFallback` once `getViirsField` succeeds.
 */
function refreshCityViirsIfReady(locationId: LocationId, exaggeration: number): void {
	if (!_cityViirsFallback.has(locationId)) return;
	const loc = LOCATION_MAP.get(locationId);
	if (!loc || !getViirsField(loc.lat, loc.lon)) return;
	if (_viirsRefresh.has(locationId) || _inFlight.has(locationId)) return;

	const job = (async () => {
		destroyCityRoads(locationId);
		await loadOfflineRoads(locationId, exaggeration);
	})().finally(() => {
		_viirsRefresh.delete(locationId);
	});
	_viirsRefresh.set(locationId, job);
}

export function initRoads(C: typeof CesiumType, viewer: CesiumType.Viewer): void {
	_cs = C;
	_viewer = viewer;
	resetOfflineRoads();
}

/**
 * Fetch + build the per-bin collections for one city. Idempotent and cached.
 * Not exported: syncOfflineRoads is the only caller and the only entry point.
 *
 * ─── ⚠ POLYLINECOLLECTION, NOT Primitive + PolylineGeometry ─────────────────
 * The obvious construction — GeometryInstances of PolylineGeometry in a single
 * batched Primitive, the way buildings-geojson batches its footprints — builds
 * and reports `ready: true`, `show: true`, a valid bounding sphere, and draws
 * NOTHING. Verified on a real GPU against a hardcoded control line in a
 * PolylineCollection at the same position, altitude and colour: the control
 * drew, the Primitive did not. Not depth (tested with depthTest off), not
 * translucency/OIT (tested opaque), not the lift (tested at 3,000 m), not
 * arcType.
 *
 * Do not "optimise" this back into a batched Primitive without a frame that
 * proves the lines are on screen. PolylineCollection does its own bucketing
 * anyway, which is what a batched Primitive was for.
 *
 * Failure is quiet by design: no grid is the state we were already in, and the
 * fiction is never broken with an error.
 */
async function loadOfflineRoads(
	locationId: LocationId,
	exaggeration = 1,
): Promise<void> {
	const C = _cs;
	const viewer = _viewer;
	if (!C || !viewer) return;
	if (_cityRoads.has(locationId)) return;
	const existing = _inFlight.get(locationId);
	if (existing) return existing;

	const job = (async () => {
		const t0 = performance.now();
		try {
			const res = await fetch(`/api/roads/${locationId}`);
			if (!res.ok) return;
			const roads = polylinesFromGeojson(await res.json(), locationId, exaggeration);
			if (roads.length === 0) return;

			const loc = LOCATION_MAP.get(locationId);
			// Kick off field load before per-road sampling; await covers first visit.
			if (loc) getViirsField(loc.lat, loc.lon);
			const field = loc ? await awaitViirsField(loc.lat, loc.lon) : null;

			const bins: CityRoads['bins'] = new Map();
			for (const r of roads) {
				const lamp = roadLampIndex(r.coords);
				const viirsScale = roadViirsScaleForPolyline(r.coords, field);
				const glowKey = viirsGlowBucketIndex(viirsScale);
				const key = `${r.cls}|${lamp}|${glowKey}`;
				let bin = bins.get(key);
				if (!bin) {
					// ⚠ HOLD THE MATERIAL, NOT THE COLOR HANDED TO IT.
					// Material.fromType CLONES its uniforms, so the Color passed in
					// is not the one the shader reads. Writing to the outer object
					// left every line pinned at its construction alpha of 0 — a
					// layer fully present in the scene, drawing nothing.
					const material = C.Material.fromType('PolylineGlow', {
						color: C.Color.fromCssColorString(ROAD_LAMPS[lamp].css).withAlpha(0),
						// Lower glowPower = tighter, brighter core. Arteries get a
						// wider halo than side streets so the hierarchy survives
						// the bloom pass rather than flattening into one mesh.
						glowPower: ROAD_LAMPS[lamp].glow * ROAD_STYLE[r.cls].glowScale,
						taperPower: 1.0,
					});
					bin = {
						lines: { show: false },
						material,
						cls: r.cls,
						viirsScale: viirsGlowBucketCenter(glowKey),
						phase: roadBinPhase(r.cls, lamp),
						alpha: new EpsilonGate<number>(0.001, -1),
						pending: [],
					};
					bins.set(key, bin);
				}
				bin.pending.push(r);
			}

			// ─── Realise each bin ───────────────────────────────────────────────
			// Two-phase (collect, then build) because the DRAPED path wants all of
			// a bin's geometry at once as GeometryInstances, while the fallback
			// wants them added one at a time. Collecting first keeps one loop.
			const draped = C.GroundPolylinePrimitive.isSupported(viewer.scene);
			for (const bin of bins.values()) {
				bin.lines = draped
					? buildDrapedBin(C, viewer, bin)
					: buildFlatBin(C, viewer, bin);
				bin.pending = [];
			}

			if (bins.size > 0) {
				_cityRoads.set(locationId, { bins, draped });
				if (field) _cityViirsFallback.delete(locationId);
				else _cityViirsFallback.add(locationId);
				console.info(
					`[Roads] ${locationId}: ${roads.length} segments, ${bins.size} bins, `
						+ `${((performance.now() - t0) / 1000).toFixed(1)}s`,
				);
			}
		} catch (e) {
			// Never break the fiction — no audience-visible error, the night city
			// simply has no grid. But do say so on the console, exactly as the
			// imagery layers do: this catch previously hid a hard construction
			// failure and presented it as "the data must be missing".
			console.warn('[Roads] layer failed for', locationId, e);
		} finally {
			_inFlight.delete(locationId);
		}
	})();

	_inFlight.set(locationId, job);
	return job;
}

/** [lon,lat,…] + one altitude → [lon,lat,h,…], Cesium's fromDegreesArrayHeights shape. */
function withHeights(coords: number[], altM: number): number[] {
	const out: number[] = [];
	for (let i = 0; i < coords.length; i += 2) out.push(coords[i], coords[i + 1], altM);
	return out;
}

/**
 * Draped bin — the roads sit ON the terrain, following every rise and cut.
 *
 * ─── ⚠ WHY DRAPING AND NOT A CONSTANT LIFT ──────────────────────────────────
 * The fallback below places every line at `groundAltM(city) + 8 m`, i.e. on a
 * flat plane at the city's nominal elevation. That is fine over Dubai and
 * Dallas and visibly wrong anywhere with relief: Denver's ground swings ~700 m
 * across its extract, so a single plane buries whole neighbourhoods inside
 * hillsides and floats others in mid-air. Hyderabad's Deccan ridges do the same
 * thing at a smaller scale, which reads as roads that mysteriously stop.
 *
 * GroundPolylineGeometry re-projects onto whatever terrain is loaded, so the
 * grid stays welded to the surface at every LOD and needs no per-vertex height
 * sampling (which would be async, 21k polylines deep, and wrong until tiles
 * stream in).
 *
 * `isSupported` is a real gate, not defensive noise: draping needs depth
 * texture support, and on a driver without it Cesium THROWS at construction
 * rather than degrading. On this fleet that would be a black night city with a
 * console error nobody reads.
 */
function buildDrapedBin(
	C: typeof CesiumType,
	viewer: CesiumType.Viewer,
	bin: RoadBin,
): { show: boolean } {
	const instances = bin.pending.map(
		(r) =>
			new C.GeometryInstance({
				geometry: new C.GroundPolylineGeometry({
					positions: C.Cartesian3.fromDegreesArray(r.coords),
					width: ROAD_STYLE[r.cls].width,
					// ⚠ NO arcType HERE. GroundPolylineGeometry accepts only
					// GEODESIC and RHUMB and THROWS a DeveloperError on
					// ArcType.NONE — which the flat path does use, so copying the
					// option across is the obvious mistake. The throw lands in the
					// loader's catch and presents as "this city has no road data",
					// which is why that catch now logs.
					//
					// Draping implies following the surface, so a straight-line arc
					// is meaningless by construction. Geodesic subdivision is the
					// price of the feature, not an oversight.
				}),
			}),
	);
	const primitive = new C.GroundPolylinePrimitive({
		geometryInstances: instances,
		appearance: new C.PolylineMaterialAppearance({ material: bin.material }),
		// The kiosk never picks roads; skipping the pick pass saves a full extra
		// render of this geometry every frame.
		allowPicking: false,
		releaseGeometryInstances: true,
		asynchronous: true,
	});
	primitive.show = false;
	viewer.scene.groundPrimitives.add(primitive);
	return primitive;
}

/**
 * Flat bin — every line on one plane at the city's nominal ground altitude.
 *
 * Fallback only, for a device whose driver cannot drape. Keeps the night city
 * present and roughly right rather than absent, which is the same bargain the
 * offline buildings tier makes. See ROAD_LIFT_M for the z-fighting margin.
 */
function buildFlatBin(
	C: typeof CesiumType,
	viewer: CesiumType.Viewer,
	bin: RoadBin,
): { show: boolean } {
	const lines = new C.PolylineCollection();
	lines.show = false;
	for (const r of bin.pending) {
		lines.add({
			positions: C.Cartesian3.fromDegreesArrayHeights(withHeights(r.coords, r.altM)),
			// Glow needs pixels to fall off across; a 1 px line has nowhere to put
			// the halo. Widths are ~2x the flat-material values.
			width: ROAD_STYLE[r.cls].width,
			material: bin.material,
		});
	}
	viewer.scene.primitives.add(lines);
	return lines;
}

/**
 * Per-frame update. Cheap enough to call unconditionally.
 *
 * Loads on demand, shows exactly the current city, hides everything else, and
 * writes at most one alpha uniform per class — and none at all during the day,
 * where every collection is simply hidden and costs zero draw calls.
 */
export function syncOfflineRoads(
	locationId: LocationId,
	nightFactor: number,
	nightLightScale: number,
	altitudeFt: number,
	wallSec: number,
	bootFade = 1,
	exaggeration = 1,
): void {
	if (!_cs || !_viewer) return;

	// Same catalogue fact the buildings tier reads: nature locations (himalayas,
	// ocean, desert, clouds) have no street grid by design.
	const isCity = !!LOCATION_MAP.get(locationId)?.hasBuildings;
	if (isCity && !_cityRoads.has(locationId)) {
		void loadOfflineRoads(locationId, exaggeration);
	}
	if (isCity) refreshCityViirsIfReady(locationId, exaggeration);

	// Same gate the raster used: below this the layer contributes nothing, so
	// hide rather than draw thousands of fully-transparent lines.
	const lit = isCity && nightFactor > 0.01;
	const base = lit ? roadMaskAlpha(nightFactor, nightLightScale, altitudeFt, bootFade) : 0;

	for (const [id, city] of _cityRoads) {
		const here = lit && id === locationId;
		for (const bin of city.bins.values()) {
			const a = here
				? clamp(
					roadClassAlpha(bin.cls, base, altitudeFt)
						* bin.viirsScale
						* roadFlicker(bin.phase, wallSec),
					0,
					1,
				)
				: 0;
			// Hide, rather than draw at an alpha nobody can see. A collection with
			// show=true is submitted for drawing at ANY alpha; residential is ~58%
			// of a city's polylines (12,595 of Hyderabad's 21,781) and
			// altitudeDetailMix fades it to ~0.013 at the 30,000 ft night band.
			//
			// ⚠ HONEST STATUS: this shows NO measurable win on a desktop GPU.
			// Same scene, same camera, single tab: 41.7 ms p50 with it on and
			// 41.7 ms with it off — the road layer is simply not the bottleneck
			// there. It is kept because the target is a Pi 5, which is fill-rate
			// bound in a way a desktop is not, and because drawing geometry that
			// cannot be seen is wrong on its own terms. Treat the Pi benefit as
			// UNMEASURED until P8-CHECKLIST line 74 is actually run.
			//
			// (An earlier version of this comment claimed a 100.3 -> 41.7 ms win.
			// That was an artifact of three Aero Window tabs each running a Cesium
			// render loop during the measurement, not this code.)
			const want = here && a > MIN_VISIBLE_ALPHA;
			if (bin.lines.show !== want) bin.lines.show = want;
			if (!want) continue;
			bin.alpha.update(a, (v) => {
				// The Material's OWN color — see the clone warning at construction.
				(bin.material.uniforms.color as CesiumType.Color).alpha = v;
			});
		}
	}
}

/** Test seam — city loaded before VIIRS field was ready and awaiting re-bin. */
export function cityRoadsAwaitingViirs(id: LocationId): boolean {
	return _cityViirsFallback.has(id);
}

registerViewerTeardown('roads-geojson', resetOfflineRoads);
