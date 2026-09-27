/**
 * Imagery — Cesium satellite base + VIIRS night lights.
 *
 * Owns base terrain imagery and the VIIRS night-light layer. The CartoDB road
 * mask that used to live here is gone: it was Enterprise-only for commercial
 * use, and the street grid is now drawn as ODbL vector polylines by
 * world/roads-geojson. This file still owns the road ALPHA CURVE
 * (roadMaskAlpha), which that layer imports — see its docstring for why the
 * curve stayed here while the rendering left.
 *
 * Setup is async (network). Sync is per-tick with EpsilonGate idempotency.
 *
 * Call lifecycle:
 *   initImagery(C, v)        — once, stores refs
 *   setupImagery()            — once, async, creates 2 imagery layers
 *   syncImagery(model, fade)  — per-tick
 */

import type * as CesiumType from 'cesium';
import { altitudeDetailMix, nightLightGain } from '$lib/world/altitude';
import { VIIRS_GIBS_BASE } from '$lib/world/viirs-field';
import { getSatelliteImagery, checkLocalTileServer, setLocalTilesAvailable, TILE_SERVER_URL } from '$lib/world/cesium-setup';
import { clamp, smoothstep } from '$lib/utils';
import { NIGHT_PALETTE } from '$content/compositions/night';
import { EpsilonGate } from './util';
import { registerViewerTeardown } from './viewer-lifecycle';

/**
 * Cesium `colorToAlpha` threshold — SSOT for VIIRS night imagery keying.
 *
 * Cesium makes a pixel transparent when its distance to `colorToAlpha`
 * (black) is ≤ threshold — evaluated on the RAW sampled colour, BEFORE
 * brightness/contrast (GlobeFS.glsl sampleAndBlend).
 *
 * Night street lamps are vector polylines (`world/roads-geojson`) modulated
 * at runtime via `viirs-field` + `viirs-glow.ts` — not a raster road layer.
 * The optional `viirs-roads` tile bake (ADR-002) remains for legacy caches only.
 */
export const COLOR_TO_ALPHA = {
	viirsThreshold: 0.01,
} as const;

interface WorldConfig {
	readonly baseNightSaturation: number; readonly viirsAlphaBoost: number; readonly viirsBrightness: number;
	readonly useThreeOverlay: boolean;
}

export interface ImageryTickInput {
	readonly nightFactor: number; readonly nightLightScale: number;
	readonly altitude: number; readonly config: { readonly world: WorldConfig };
}

type C = typeof CesiumType;

let _cs: C;
let _viewer: CesiumType.Viewer;

let _baseLayer: CesiumType.ImageryLayer | null = null;
let _baseDaySaturation = 1.0;
let _baseDayGamma = 1.0;
let _baseNightGamma = 1.0;
let _viirsLayer: CesiumType.ImageryLayer | null = null;

let _lastNightFactor = -1;
const _viirsShow = new EpsilonGate<boolean>(0, false);
const _viirsAlpha = new EpsilonGate<number>(0.001, -1);
const _viirsBrightness = new EpsilonGate<number>(0.01, -1);
export function initImagery(Cesium: C, viewer: CesiumType.Viewer): void {
	_cs = Cesium; _viewer = viewer;
	resetImageryViewerState();
}

/**
 * Drop layer handles from the PREVIOUS viewer. They belong to a viewer that is
 * being (or has been) destroyed; keeping them means setupImagery skips
 * re-adding — `if (_baseLayer)` is truthy — and every later sync writes into
 * layers that are no longer in any scene. Nothing throws, the globe just
 * renders bare.
 *
 * Registered with viewer-lifecycle so teardown happens on destroy as well as
 * on the next mount.
 */
export function resetImageryViewerState(): void {
	_baseLayer = null;
	_viirsLayer = null;
	_viirsShow.reset();
	_viirsAlpha.reset();
	_viirsBrightness.reset();
	_lastNightFactor = -1;
}
registerViewerTeardown('imagery', resetImageryViewerState);

export async function setupImagery(): Promise<void> {
	const C = _cs;
	// Resolve the local cache BEFORE choosing a source: base imagery has no
	// per-tile fallback, so picking local against an empty TILE_DIR yields a
	// bare globe. Same probe setupTerrain uses; ~500 ms worst case at boot, and
	// it short-circuits instantly when no tile server is configured at all.
	const localTiles = await checkLocalTileServer();
	setLocalTilesAvailable(localTiles);
	const cfg = getSatelliteImagery(localTiles);


	_baseLayer = _addLayer(cfg.url, cfg.maxZoom, 0, cfg.webMercator);
	if (_baseLayer) {
		// ─── ⚠ THESE CLIP DARK PIXELS — TUNE AGAINST WATER, NOT LAND ────────
		// Cesium applies contrast as mix(0.5, color, c), then saturation as
		// mix(luma, color, s) with luma weights (0.2125, 0.7154, 0.0721).
		// Both EXTRAPOLATE past 1.0, and blue carries only 7% of the luma — so
		// on a dark blue pixel they drive R and G negative, where they clamp to
		// zero and leave pure blue. That read as a purple ocean.
		//
		// Measured on a real EOX tile (open Pacific, z7): raw RGB 13/25/44,
		// hue 217°. At the old contrast 1.3 / saturation 1.6 it came out
		// 0/3/47, hue 236°, with a channel clipped on 100% of ocean pixels
		// (land: 1.5%). At 1.05/1.30 it lands 8/27/55, hue 216.5°, 0.1% clipped.
		//
		// Cost: land saturation drops ~0.94 → ~0.58. The old values were pushing
		// terrain well past its native 0.46, so this is closer to the source.
		// EOX is flatter than Mapbox/Esri, hence still a boost, just not one
		// that clips. Re-measure before raising either number.
		// Keyed on the DATA, not the host: the remote EOX mosaic (dev only) and
		// the packaged Copernicus `sentinel2` tree are the same Sentinel-2
		// pixels, so both take this branch. A vendor-name test here once sent
		// the packaged path down the Mapbox branch and quietly undid the
		// measured purple-ocean values the moment the tiles landed on a Pi.
		const isEox = /eox|sentinel2/.test(cfg.label);

		_baseDaySaturation = isEox ? 1.3 : 1.25;
		_baseLayer.saturation = _baseDaySaturation;
		_baseLayer.contrast = isEox ? 1.05 : 1.1;
		_baseLayer.brightness = 1.0;

		// Gamma is the ONLY non-clipping brightness lever here. Cesium's uniform
		// is OneOverGamma — the shader computes pow(color, 1/gamma) — so gamma>1
		// maps 1.0→1.0 exactly while lifting midtones and shadows. Unlike the
		// contrast/saturation pair above it cannot drive a channel negative, so
		// the purple-ocean failure mode does not apply.
		//
		// Day is lifted; NIGHT KEEPS THE OLD VALUE. The night look (VIIRS balance,
		// road-mask contrast, corona) was measured against a dark ground, and a
		// gamma lift is proportionally largest exactly there — pow(0.05, 1/1.25)
		// is nearly 2× — which would wash out the night-light layers it sits
		// under. Lerped on the same baseEase as saturation, so at full night the
		// value is bit-identical to before this change.
		_baseDayGamma = isEox ? 1.25 : 1.15;
		_baseNightGamma = isEox ? 1.1 : 1.0;
		_baseLayer.gamma = _baseDayGamma;
	}

	// ─── ⚠ GATED ON localTiles, NOT ON THE URL BEING SET ────────────────────
	// TILE_SERVER_URL is written by install.sh on EVERY Pi (default
	// `/api/tiles`), so its presence says nothing about whether tiles exist.
	// checkLocalTileServer() above is what actually probes /api/tiles/health for
	// hasTiles, and the base imagery already consults it — getSatelliteImagery
	// takes localTiles and falls back to the remote host when the cache is
	// empty. The VIIRS and road layers below did not, and pointed at the local
	// path purely because the variable was non-empty.
	//
	// On the current fleet, where the ~2.7 GB has never been rsynced, that meant
	// every VIIRS and road tile 404'd while base imagery streamed happily from
	// EOX. The visible result at night: terrain and lit building windows, and NO
	// ground light field and NO street grid at all — the two layers that carry
	// the city. Silent, because a 404 on an ImageryLayer is a blank tile, not an
	// error, and /api/tiles/health reports layer DIRECTORIES rather than content.
	//
	// One flag, three layers. Now they agree.
	const tileBase = localTiles ? TILE_SERVER_URL?.replace(/\/$/, '') : undefined;

	// Add order = composite order: base → VIIRS → road mask. Roads sit ON TOP
	// ("Roads carry the city; VIIRS fills behind" — roadMaskAlpha): VIIRS is a
	// coarse 583 m/px glow that would otherwise mute the crisp z18 road strokes
	// by up to maxAlpha exactly where both peak (city cores), and its near-black
	// pixels (colorToAlphaThreshold keys only TRUE black) darkened them further.
	try {
		_viirsLayer = _addLayer(
			tileBase ? `${tileBase}/viirs-night-lights/{z}/{y}/{x}.jpg`
				: `${VIIRS_GIBS_BASE}/{z}/{y}/{x}.png`,
			8, 3, !!tileBase,
		);
		if (_viirsLayer) {
			_viirsLayer.alpha = 0; _viirsLayer.show = false;
			_viirsLayer.dayAlpha = 0; _viirsLayer.nightAlpha = 1;
			_viirsLayer.colorToAlpha = C.Color.BLACK;
			_viirsLayer.hue = 0.0; _viirsLayer.saturation = 0.0;
			// Soft fill only — roads on top carry structure (see road brightness).
			_viirsLayer.brightness = 1.6; _viirsLayer.contrast = 0.85;
			// See COLOR_TO_ALPHA — true-black NASA tiles only need a hairline.
			_viirsLayer.colorToAlphaThreshold = COLOR_TO_ALPHA.viirsThreshold;
		}
	} catch (e) { console.warn('[Imagery] VIIRS layer failed:', e); }

	// ─── THE ROAD MASK USED TO BE ADDED HERE ────────────────────────────────
	// It was a CartoDB `dark_nolabels` raster (and the `viirs-roads` composite
	// baked from it) — Enterprise-only for commercial use, and 132 MB of the
	// 139 MB tile cache. Replaced by world/roads-geojson, which draws the same
	// grid as ODbL vector polylines and still drives its alpha from
	// roadMaskAlpha() below, so the tuned night curve is unchanged.
}

function _addLayer(url: string, maximumLevel: number, minimumLevel: number, webMercator: boolean): CesiumType.ImageryLayer | null {
	return _viewer.imageryLayers.addImageryProvider(
		new _cs.UrlTemplateImageryProvider({
			url, maximumLevel, minimumLevel,
			...(webMercator ? { tilingScheme: new _cs.WebMercatorTilingScheme() } : {}),
		}),
	);
}
/**
 * VIIRS night-lights layer alpha.
 *
 * Pure so the clamp can be tested — the layer itself is module-private and only
 * exists after a networked setupImagery(), which is exactly why the saturation
 * bug below survived: nothing could assert on it without a live viewer.
 *
 * ─── ⚠ THE CEILING IS maxAlpha, NOT 1.0 ─────────────────────────────────────
 * `scale` (the operator's Night Lights knob) and `boost` multiply INTO this, so
 * clamping at 1.0 let them overrun the palette ceiling: at the shipped defaults
 * the product reaches 5.6, pinning alpha fully opaque for every nightFactor
 * past the smoothstep knee, at every altitude. The NASA tiles then read as a
 * flat amber wash rather than lit terrain over shader-darkened ground, and 82%
 * of the slider's 0..5 travel did nothing — with the 5.0 default sitting deep
 * inside that dead zone.
 */
export function viirsLayerAlpha(
	nightFactor: number,
	scale: number,
	altitudeFt: number,
	alphaBoost: number,
	bootFade = 1,
): number {
	const V = NIGHT_PALETTE.viirs;
	const ease = smoothstep(
		(nightFactor - V.smoothstepFloor) / Math.max(V.smoothstepCeil - V.smoothstepFloor, 0.001),
	);
	// Floored at V.lowAltFloor: the gate fades VIIRS to zero by 5k ft, which
	// left flyover-altitude night terrain a black void. The floor keeps a dim
	// halo under the road mask — roads carry structure, VIIRS carries the
	// pooled city glow (see the palette note).
	const altGate = Math.max(V.lowAltFloor, 1 - altitudeDetailMix(altitudeFt));
	const boost = 1.0 + (alphaBoost - 1.0) * nightFactor;
	// `scale` is nightLightIntensity, a 0..5 knob SHARED with the shader uniforms,
	// where a gain of 5 is meaningful. An ALPHA cannot use it raw: at 5 it
	// overruns any ceiling instantly. Normalising against the slider maximum
	// keeps the whole travel expressive instead of pinning at ~0.7 and leaving
	// most of the control inert.
	const gain = nightLightGain(scale);
	// ─── ⚠ boost > 1 COSTS YOU THE ALTITUDE GATE ────────────────────────────
	// clamp(maxAlpha * X, 0, maxAlpha) === maxAlpha * clamp(X, 0, 1), so any
	// X > 1 pins the result flat. Every term except `boost` is already <= 1, so
	// boost alone decides whether altGate survives. At the old default of 1.4
	// with gain 1, X ran 1.07..1.35 across the ENTIRE 28-34k night-show band:
	//
	//   28,000 ft  altGate 0.767 → raw 0.644 → clamped 0.60
	//   34,000 ft  altGate 0.967 → raw 0.812 → clamped 0.60
	//
	// i.e. altitude had zero effect on any real night show. The ceiling itself
	// is correct and deliberate (see the palette-overrun note above) — the fix
	// is the default, now 1.0 (config-tree world.viirsAlphaBoost). Raising it
	// past ~1.03 re-flattens the gate; maxAlpha is the knob to reach for.
	return clamp(V.maxAlpha * ease * gain * altGate * boost, 0, V.maxAlpha) * bootFade;
}

/**
 * Road-light alpha curve — "how lit is the street grid right now".
 *
 * ⚠ THE NAME IS HISTORICAL. There is no mask layer any more. This was the
 * alpha of a CartoDB raster imagery layer; that layer was removed for licensing
 * and the grid is now vector polylines in world/roads-geojson, which imports
 * this function verbatim. The curve stayed here because it is shared SSOT with
 * viirsLayerAlpha — the two are tuned against each other and drift apart the
 * moment they live in different files.
 *
 * Verified against the vector renderer on a real GPU at 30,000 ft over
 * Hyderabad: the range this produces (~0.27 for arteries at the night band)
 * renders a legible city. A "vector gain" multiplier was tried and reverted —
 * see ROAD_VECTOR_GAIN's obituary in roads-geojson for the misdiagnosis.
 *
 * Clamped for the same reason as VIIRS: `scale` multiplies in, so at the 5.0
 * default this evaluated to 1.5-3.7 and was assigned with NO clamp at all
 * (observed live: 3.664). Cesium treats >= 1 as fully opaque, so every value
 * above 1 was both meaningless and indistinguishable, and the altitude gate
 * could never actually fade the mask.
 */
export function roadMaskAlpha(
	nightFactor: number,
	scale: number,
	altitudeFt: number,
	bootFade = 1,
): number {
	// Floor raised 0.3 → 0.6 (span 0.7 → 0.4, so the low-altitude end still
	// reaches 1.0). Roads are the structured source of street-grid detail;
	// VIIRS is a 583 m/px blur. The old floor faded roads to 0.32-0.46 across
	// the 28-34k night-show band while VIIRS sat pinned at its ceiling, so the
	// structured layer was quietest exactly where the blobby one was loudest.
	// Roads carry the city; VIIRS fills behind.
	//
	// ⚠ THE ORIGINAL JUSTIFICATION FOR THIS FLOOR NO LONGER HOLDS AS WRITTEN.
	// It argued the road mask was "the ONLY globally-available source" of
	// structure, "baked z4–12". Both facts died with the raster: the vector
	// grid is not baked at any zoom, and it is NOT global — each city ships a
	// ~5-8 km extract (denver is 4.2 x 2.3 km), against a ~100 km view at the
	// night band. So the road:VIIRS balance this floor targets now holds only
	// over the flown city, and VIIRS alone carries the far field. The floor
	// still measures right for the near field, which is why it is unchanged —
	// but re-derive it, do not re-cite the old numbers, if you touch it. That
	// is exactly how the nightLightGain regressions catalogued in altitude.ts
	// happened.
	const gate = 0.6 + 0.4 * altitudeDetailMix(altitudeFt);
	const nf = nightFactor;
	// Normalise the 0..5 operator gain, exactly as viirsLayerAlpha does. Clamping
	// alone left this pinned at 1.0 for every altitude and every knob position
	// above ~0.3, so the altitude gate above could never actually fade the mask
	// and most of the slider was inert.
	const gain = nightLightGain(scale);
	return clamp(nf * gain * gate + (1 - nf) * 0.08 * gate, 0, 1) * bootFade;
}

/**
 * Day→night ease for the base layer's filters. Both saturation and gamma ride
 * it, so they can never disagree about when night has arrived.
 *
 * Pure, and exported for test: the layer it drives is module-private and only
 * exists after a networked setupImagery(), so this is the only way to assert
 * that the day-side gamma lift leaves the measured night look alone. Reaches
 * exactly 0 at nf <= 0.45 and exactly 1 at nf >= 0.9 (smoothstep clamps), which
 * is what makes "night is bit-identical" a fact rather than an approximation.
 */
export function baseNightEase(nf: number): number {
	return smoothstep((nf - 0.45) / (0.9 - 0.45));
}

export function syncImagery(model: ImageryTickInput, bootFade: number): void {
	const nf = model.nightFactor;
	const scale = model.nightLightScale;
	const show = nf > 0.01;
	const prev = _lastNightFactor;
	_lastNightFactor = nf;

	const w = model.config.world;

	if (_baseLayer) {
		const baseEase = baseNightEase(nf);
		_baseLayer.saturation = _baseDaySaturation + (w.baseNightSaturation - _baseDaySaturation) * baseEase;
		_baseLayer.gamma = _baseDayGamma + (_baseNightGamma - _baseDayGamma) * baseEase;
	}

	if (_viirsLayer) {
		const viirsAlpha = viirsLayerAlpha(nf, scale, model.altitude, w.viirsAlphaBoost, bootFade);
		const viirsShow = (show || (prev < 0.01 && nf > 0.01)) && viirsAlpha > 0.001;
		// 5.0× → 3.2×: with default viirsBrightness 1.55 this lands ~5.0 instead
		// of ~15. Soft VIIRS at 15× brightness re-soaked cities under the grade.
		const viirsBrightness = 3.2 * w.viirsBrightness;

		_viirsShow.update(viirsShow, (v) => { _viirsLayer!.show = v; });
		_viirsAlpha.update(viirsAlpha, (v) => { _viirsLayer!.alpha = v; });
		_viirsBrightness.update(viirsBrightness, (v) => { _viirsLayer!.brightness = v; });
	}
	// Roads: see world/roads-geojson, driven from the same roadMaskAlpha().
}
