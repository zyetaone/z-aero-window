/**
 * viewer-lifecycle: tab-scoped
 *
 * This module holds module-level state and touches a Viewer, so the teardown
 * coverage test flags it — correctly, by its own heuristic. It is exempt on
 * purpose, and the exemption lives here so anyone adding state to this file
 * has to think about which scope it belongs to.
 *
 * What lives here is scoped to the TAB, not to a viewer: the resolved Ion
 * token and the local-tile-server probe result. Both are answers about the
 * DEVICE, and neither changes when Cesium replaces a viewer. Clearing them on
 * every remount would refetch the token and re-probe the tile server on each
 * auto-retry — turning a recovery path into a slower one, and adding network
 * round-trips to exactly the moment the app is already struggling.
 *
 * If genuinely viewer-scoped state is ever added to this file, it does NOT get
 * to inherit this exemption: give it its own reset and register that.
 */
/**
 * Cesium Global Config
 *
 * Centralizes Ion tokens and environmental settings for the Cesium engine.
 */

import type * as CesiumType from 'cesium';
import type { QualityMode } from '$lib/types';
import { EOX_SENTINEL2, MAPBOX_SATELLITE_URL } from '$lib/upstream';

type C = typeof CesiumType;

// Environment markers — exported ones are imported elsewhere; others are
// private to this module's getSatelliteImagery().
export const TILE_SERVER_URL = import.meta.env.VITE_TILE_SERVER_URL || null;
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN || null;


/**
 * EOX Sentinel-2 Cloudless 2024 — natural-color cloudless composite from
 * Sentinel-2 satellite imagery. Free, no auth.
 *
 * Caveats vs ESRI:
 *   - Max zoom 14 (vs ESRI 19) — fine at cruise altitude (z14 ≈ 10 m/pixel)
 *   - WebMercator (3857) tiling scheme — construct provider with
 *     `tilingScheme: new Cesium.WebMercatorTilingScheme()`
 *   - URL uses {z}/{y}/{x} order (y before x) — natural for WMTS
 */
const SENTINEL2_EOX_URL = EOX_SENTINEL2.url;

/** Build-time token — only present when VITE_CESIUM_ION_TOKEN was set at
 *  `vite build`. That's the dev path; a CI-built artifact deliberately has
 *  none, so the runtime endpoint below is what feeds a fielded Pi. */
function buildTimeIonToken(): string | null {
	const token = import.meta.env.VITE_CESIUM_ION_TOKEN;
	if (!token || token === 'your-cesium-ion-token-here') return null;
	return token;
}

// Resolved once by resolveIonToken() and cached for the tab's lifetime. Kept
// as module state so getIonToken() can stay SYNCHRONOUS — compose.ts calls it
// later, mid-scene, for the buildings tileset, and making that path async
// would ripple through the whole Cesium layer for no benefit.
let resolvedToken: string | null = null;
let tokenResolved = false;

/**
 * Fetch the Ion token from the Pi's localhost-only endpoint, falling back to
 * the build-time value. Safe to call repeatedly — resolves at most once.
 *
 * Order matters: runtime FIRST. A CI-built artifact has no build-time token,
 * and a locally-built dev bundle has no server env — so whichever exists wins,
 * and a Pi that has both prefers the one in /etc/aero/config.env (the value an
 * operator can rotate without rebuilding).
 */
export async function resolveIonToken(): Promise<string | null> {
	if (tokenResolved) return resolvedToken;
	let runtime: string | null = null;
	try {
		const res = await fetch('/api/internal/token?type=cesium', { cache: 'no-store' });
		if (res.ok) {
			const body = (await res.json()) as { token?: unknown };
			if (typeof body.token === 'string' && body.token.length > 0) runtime = body.token;
		}
	} catch {
		// Offline, non-localhost, or endpoint absent (older build) — fall through.
	}
	resolvedToken = runtime ?? buildTimeIonToken();
	tokenResolved = true;
	return resolvedToken;
}

/**
 * Access the Cesium Ion token. Synchronous by design (see above).
 *
 * Before resolveIonToken() completes this returns the build-time token, which
 * is null on a CI-built artifact — so call sites that gate features on it
 * (compose.ts buildings/terrain) must run AFTER initCesiumGlobal, which they
 * do: the manager is constructed on the line following it.
 */
export function getIonToken(): string | null {
	return tokenResolved ? resolvedToken : buildTimeIonToken();
}

/**
 * Perform one-time global initialization for the Cesium module.
 * Async since Phase 19: the Ion token is fetched at runtime so it no longer
 * has to be baked into the bundle.
 */
export async function initCesiumGlobal(C: typeof CesiumType): Promise<void> {
	const token = await resolveIonToken();
	if (token) {
		C.Ion.defaultAccessToken = token;
	}

	// Set base URL for static assets (workers, etc.)
	(globalThis as any).CESIUM_BASE_URL = '/cesiumStatic';
}

/** Test-only reset hook — module state is per-process. */
export function __resetIonTokenCacheForTests(): void {
	resolvedToken = null;
	tokenResolved = false;
}

/**
 * Shared Cesium.Viewer constructor options — strips all built-in widgets
 * (toolbar, geocoder, animation, etc.) so the canvas is purely a render surface.
 *
 * `webgl` defaults to alpha=false (opaque); pass `webgl: { alpha: true }`
 * via override when the page wants a CSS gradient to show through.
 */
export const VIEWER_OPTIONS = {
	baseLayer: false as const,
	animation: false,
	baseLayerPicker: false,
	fullscreenButton: false,
	vrButton: false,
	geocoder: false,
	homeButton: false,
	infoBox: false,
	sceneModePicker: false,
	selectionIndicator: false,
	timeline: false,
	navigationHelpButton: false,
	navigationInstructionsInitiallyVisible: false,
	// Enable shadow map so OSM Buildings + terrain cast real shadows at
	// dawn/dusk. Sun position is synced from model.timeOfDay in syncClock,
	// so shadow direction lines up with the in-scene lighting.
	shadows: true,
	useBrowserRecommendedResolution: false,
	contextOptions: {
		webgl: { alpha: false, antialias: true, preserveDrawingBuffer: true },
	},
} as const;

/**
 * Imagery source configuration — captures everything CesiumManager needs to
 * construct a UrlTemplateImageryProvider (URL + max zoom + tiling scheme hint).
 */
interface ImageryConfig {
	url: string;
	maxZoom: number;
	/** Set true for sources that use WebMercator tiling (e.g. EOX, Mapbox). */
	webMercator: boolean;
	/** Human-readable label for logs/credits. */
	label: string;
}

/**
 * Get primary satellite imagery configuration.
 * Priority: Local tile server → Mapbox → EOX Sentinel-2 Cloudless
 *
 * EOX Sentinel-2 is the default (no Mapbox token needed) — natural cloudless
 * composite, gorgeous at cruise altitude.
 *
 * ESRI World Imagery was the last-resort fallback and has been REMOVED: it is
 * proprietary (Maxar/Airbus via Esri) and the free endpoint does not cover a
 * commercial kiosk, let alone bulk-caching it to disk. See $lib/upstream, which
 * records every origin and its licence — including the ones we removed.
 */
export function getSatelliteImagery(localAvailable = true): ImageryConfig {
	// `localAvailable` is the checkLocalTileServer() verdict. Unlike terrain —
	// which degrades local → Ion → ellipsoid on its own — this path has no
	// per-tile fallback: whatever URL is returned here is the ONLY imagery
	// source. Choosing local when the cache is empty means no imagery at all,
	// so the caller must resolve availability first. Defaults true so the
	// meaning of a bare call is unchanged for existing callers/tests.
	if (TILE_SERVER_URL && localAvailable) {
		// Local pack: Sentinel-2 built from the public `sentinel-cogs` bucket
		// under the Copernicus licence (commercial use permitted, attribution
		// required — see $lib/upstream COPERNICUS_SENTINEL2). Layout is WMTS
		// `sentinel2/{z}/{y}/{x}.jpg`, the same tree aero-2 ships; the EOX
		// mosaic is NOT packaged any more because CC BY-NC-SA does not cover a
		// paid install. When the pack misses, the tile shows the base colour.
		return {
			url: `${TILE_SERVER_URL}/sentinel2/{z}/{y}/{x}.jpg`,
			maxZoom: 13,
			webMercator: true,
			label: 'local-sentinel2',
		};
	}
	if (MAPBOX_TOKEN) {
		return {
			url: `${MAPBOX_SATELLITE_URL}${MAPBOX_TOKEN}`,
			maxZoom: 19,
			webMercator: true,
			label: 'mapbox-satellite',
		};
	}
	// EOX Sentinel-2 Cloudless. The VITE_SENTINEL2=false opt-out went with the
	// ESRI branch it selected — there is nothing else to fall back to.
	return { url: SENTINEL2_EOX_URL, maxZoom: 14, webMercator: true, label: 'eox-sentinel2' };
}

/**
 * Is the local tile cache usable — server reachable AND actually holding tiles?
 *
 * Both halves matter. The route answers 200 even when TILE_DIR is empty or
 * missing, so "reachable" alone would green-light the local imagery URL and
 * paint a globe of 404s. /health now reports `hasTiles`; an older server that
 * doesn't send the field is treated as usable, since before this existed the
 * flag was only ever set on devices that had been packaged.
 */
// Last probe verdict, so tile-budget decisions can ask "are we on local disk?"
// without re-probing. Set by setupImagery, which already awaits the check;
// read by applyQualityMode, which runs after it. Defaults false, which is the
// conservative answer — a wrong `true` would mean hammering EOX/GIBS over a
// client's WiFi, so the fallback must never be the aggressive branch.
let _localTiles = false;
export function setLocalTilesAvailable(v: boolean): void { _localTiles = v; }
export function localTilesAvailable(): boolean { return _localTiles; }

// Layer names the last health probe reported (non-empty directories under
// TILE_DIR). Older servers omit `layers` — treated as "unknown", so
// layer-specific checks (viirs-roads) conservatively answer false.
let _localLayers: string[] = [];
export function localTileLayerAvailable(name: string): boolean {
	return _localLayers.includes(name);
}

export async function checkLocalTileServer(): Promise<boolean> {
	if (!TILE_SERVER_URL) return false;
	try {
		const resp = await fetch(`${TILE_SERVER_URL}/health`, {
			signal: AbortSignal.timeout(500)
		});
		if (!resp.ok) return false;
		const body = await resp.json().catch(() => null) as { hasTiles?: boolean; layers?: unknown } | null;
		_localLayers = Array.isArray(body?.layers)
			? body.layers.filter((l): l is string => typeof l === 'string')
			: [];
		return body?.hasTiles !== false;
	} catch {
		return false;
	}
}

/**
 * Apply one-time scene recipes the kiosk always sets.
 *
 * Centralizes the 13 lines of post-construction scene configuration that
 * used to live inline in CesiumManager.start():
 *   - logarithmicDepthBuffer / highDynamicRange (Pi 5 depth precision + HDR)
 *   - tonemapper=ACES + exposure=1.0 (calm-amber baseline)
 *   - globe.enableLighting (terminator-driven night shading)
 *   - requestRenderMode=false (model state mutates per RAF tick)
 *   - skyBox/skyAtmosphere/sun on, moon off (Three owns moon)
 *   - oceanNormalMapUrl for water shimmer
 *   - screen-space input disabled (kiosk is blind + side panel only)
 *
 * Splitting this off keeps CesiumManager.start() readable and gives
 * tests + playground one place to set a known-good scene baseline.
 */
export interface CesiumQualityPreset {
	maximumScreenSpaceError: number;
	tileCacheSize: number;
	preloadSiblings: boolean;
	preloadAncestors: boolean;
	loadingDescendantLimit: number;
}

export const CESIUM_QUALITY_PRESETS: Record<QualityMode, CesiumQualityPreset> = {
	performance: {
		maximumScreenSpaceError: 8,
		tileCacheSize: 50,
		preloadSiblings: false,
		preloadAncestors: true,
		loadingDescendantLimit: 4,
	},
	balanced: {
		maximumScreenSpaceError: 5,
		tileCacheSize: 100,
		preloadSiblings: true,
		preloadAncestors: true,
		loadingDescendantLimit: 6,
	},
	ultra: {
		maximumScreenSpaceError: 2,
		tileCacheSize: 200,
		preloadSiblings: true,
		preloadAncestors: true,
		loadingDescendantLimit: 8,
	},
};

export function applySceneDefaults(viewer: CesiumType.Viewer, C: C): void {
	const v = viewer;
	v.scene.logarithmicDepthBuffer = true;
	v.scene.highDynamicRange = true;
	v.scene.postProcessStages.fxaa.enabled = true;
	v.scene.screenSpaceCameraController.enableInputs = false;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(v.scene.postProcessStages as any).tonemapper = (C as any).Tonemapper.ACES;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(v.scene.postProcessStages as any).exposure = 1.0;
	v.scene.globe.enableLighting = true;
	if (v.shadowMap) v.shadowMap.enabled = true;
	v.scene.requestRenderMode = false;
	v.scene.globe.oceanNormalMapUrl = C.buildModuleUrl('Assets/Textures/waterNormals.jpg');

	if (v.scene.skyAtmosphere) v.scene.skyAtmosphere.show = true;
	if (v.scene.skyBox) (v.scene.skyBox as { show: boolean }).show = true;
	if (v.scene.sun) { v.scene.sun.show = true; v.scene.sun.glowFactor = 2.0; }
	if (v.scene.moon) v.scene.moon.show = true;
}
