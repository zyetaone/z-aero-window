/**
 * Tile template generators, zoom thresholds, attribution and coverage bounding boxes.
 */

export const TILE_SIZE = 256;

export const TILE_MAXZOOM = {
	/**
	 * Sentinel-2 is 10 m and a z14 web-mercator pixel is 9.55 m, so z14 is the
	 * last zoom backed by real source pixels. Packed to z13 today, except
	 * Dubai and Mumbai which hold z14 (110 MB); the other seven stop at 13,
	 * so raising the cap now would 404 over them. Complete z14 coverage
	 * first (Phase 1), then raise. Beyond 14 only upscales.
	 */
	sentinel2: 13,
	gibs: 9,
	/** VIIRS ships GoogleMapsCompatible_Level8 — there is no z9 to ask for. */
	viirs: 8,
	terrarium: 13,
	/**
	 * Packed to z11 today, not the tool's z13 default.
	 *
	 * The manifest is the authority — `data/tiles/water/source-*.json` records
	 * what actually got written. Dubai and Mumbai hold z12/z13 (14 MB); Chicago
	 * stops at 11, so declaring 13 here would 404 every tile on approach over
	 * Chicago — the same trap the DEM's missing zoom range set. Raise the cap
	 * once Chicago is packed to 13 (Phase 1), not before.
	 */
	water: 11
} as const;

/**
 * Below this, Sentinel-2 is not packed and MODIS carries the picture.
 *
 * The packs are per-location boxes, not a global layer: fetching every city at
 * z8-13 is affordable, fetching the planet is not. So the source is mounted
 * with its own minzoom and MapLibre simply requests nothing below it.
 */
export const SENTINEL2_MINZOOM = 8;

/**
 * Locations the Sentinel-2 layer is actually packed for.
 *
 * Mounting the source unconditionally costs real traffic where it has no
 * tiles: over the Pacific the kiosk fired 203 requests in 16 seconds and 404'd
 * every one. Harmless to look at — MODIS is underneath, which is the point of
 * an overlay — but it is a request storm for imagery that cannot exist, the
 * same waste `raster-opacity: 0` used to cause and that unmounting fixed.
 *
 * Two places are absent, for two different reasons worth keeping straight:
 *
 *   ocean          Sentinel-2 does not image open water. No date helps.
 *   desert         no SINGLE acquisition covers the visible box. Verified
 *                  against a full year at 12% cloud: the mosaic came out
 *                  17-35% empty every time and the packager refused to tile
 *                  it, which is correct — black wedges are worse than a soft
 *                  basemap.
 *
 *                  Dubai and Mumbai were in this second bucket and have since
 *                  been packed (multi-date envelopes: dubai summer 2026,
 *                  mumbai Jan–Apr dodging the monsoon). Their gaps are closed
 *                  by mosaicking, which is the Phase 1 recipe for `desert`.
 *
 *                  Two of the three are coastal, so the obvious suspicion is
 *                  that the "empty" area is SEA being miscounted as nodata.
 *                  It is not, checked two ways: a packed Lake Michigan tile
 *                  measures 0.14% below the nodata threshold, and Mumbai's
 *                  own coverage proof shows the Arabian Sea imaged cleanly
 *                  while the hole sits INLAND to the north-east, around
 *                  73.5-74.5E. `desert` has no water at all and still fails.
 *
 *                  Nor is it only the far field: clipped to the near box
 *                  alone, Mumbai is still 8.3% empty against a 1% budget. The
 *                  gaps are real, and they are where the window looks.
 *
 * Keep this in step with `data/tiles/sentinel2/source-*.json`; a name here with
 * no pack behind it is exactly the request storm above.
 */
/**
 * Locations the water mask is packed for.
 *
 * Same gate as SENTINEL2_PLACES and for the same measured reason: an unmounted
 * source costs nothing, a mounted one with no tiles is a request storm of 404s.
 * Chicago came first — Lake Michigan dominates its window — and Dubai and
 * Mumbai followed, both coastal and both measuring ~46-49% water over the
 * visible area, which is where a glint earns its place.
 *
 * The Pacific show is NOT here and cannot be: the mask derives from Sentinel-2's
 * scene classification, and Sentinel-2 does not image open water. The tiles
 * around Honolulu come back 77-100% nodata at any cloud threshold. Open ocean
 * keeps the MODIS basemap, which is the honest answer rather than a gap.
 *
 * Mumbai's mask is packed from a JANUARY-APRIL window, not the summer default:
 * the monsoon leaves no scene under 15% cloud between July and September. The
 * mask is a coastline, and coastlines do not move between seasons — which is
 * exactly why fetch-water-mask.py picks its own date independently of the
 * basemap's.
 *
 * Keep in step with `data/tiles/water/source-*.json`.
 */
export const WATER_PLACES: ReadonlySet<string> = new Set(['chicago_midway', 'dubai', 'mumbai']);

/** Below this the mask is not packed, and the coastline is not resolvable anyway. */
export const WATER_MINZOOM = 8;

export const SENTINEL2_PLACES: ReadonlySet<string> = new Set([
	'chicago_midway',
	'dallas',
	'denver',
	'dubai',
	'himalayas',
	'hyderabad',
	'las_vegas',
	'mumbai',
	'phoenix'
]);

/**
 * Both sources are credited because both are drawn: Sentinel-2 over the nine
 * packed locations, MODIS everywhere else and under the gaps.
 *
 * The Copernicus notice is not decoration — the licence REQUIRES attribution,
 * and "Contains modified Copernicus Sentinel data" is the exact wording it
 * specifies for data that has been reprojected and retiled, which this has.
 */
export const TILE_ATTRIBUTION =
	'Contains modified Copernicus Sentinel data 2026 · Imagery: NASA EOSDIS GIBS · Elevation: Mapzen / AWS Open Data';

/**
 * The DEM archive URL, under whatever tile origin this pane is configured for.
 *
 * Was a hardcoded `/api/tiles/...` constant, which meant PUBLIC_TILE_SERVER_URL
 * could not move it even once the raster layers honoured it -- so a shared
 * tile-server deployment would have fetched imagery from one host and elevation
 * from another. The prefix is a PARAMETER rather than an env read because this
 * module is pure and unit-tested; `$app/env/public` resolves in components.
 */
export function terrainPmtilesUrl(prefix = '/api/tiles'): string {
	return `pmtiles://${prefix}/terrain.pmtiles`;
}

/** Floor of the packed DEM pyramid. Must match what pack-pmtiles wrote. */
export const TERRAIN_MINZOOM = 5;

export const HILLSHADE_DEFAULT = 0.85;
export const HILLSHADE_SHADOW_COLOR = '#1a2436';
/**
 * Terrain at its real height. 1.0 is not a tuning choice, it is the datum.
 *
 * 2.5x was compensating for something else: GIBS at z9 is ~250 m/px, so relief
 * was invisible in the imagery and the mesh was pushed to make it legible. That
 * traded a texture problem for a geometry lie -- Everest was drawn at 22,122 m,
 * three times higher than any airliner flies, and every camera altitude had to
 * be scaled to match or the window filled with hillside.
 *
 * The honest fix for flat-looking ground is sharper ground (Sentinel-2 at z14
 * is ~9.5 m/px) and hillshade, not a taller planet. At 1.0 the drawn surface
 * and the flight envelope finally use the same units, which is what makes an
 * altitude in the HUD mean anything.
 */
export const TERRAIN_EXAGGERATION = 1.0;

export const IMAGERY_GRADE = {
	saturation: -0.08,
	contrast: 0.06,
	resampling: 'linear' as const,
	fadeDuration: 0
};

export function tileTemplates(prefix = '/api/tiles'): {
	sentinel2: string[];
	gibs: string[];
	viirs: string[];
	terrarium: string[];
	water: string[];
} {
	return {
		sentinel2: [`${prefix}/xyz/sentinel2/{z}/{x}/{y}.jpg`],
		gibs: [`${prefix}/xyz/gibs/{z}/{x}/{y}.jpg`],
		viirs: [`${prefix}/xyz/viirs/{z}/{x}/{y}.png`],
		terrarium: [`${prefix}/xyz/terrarium/{z}/{x}/{y}.png`],
		// PNG, not JPEG: this is a MASK, and compression ringing at a shoreline
		// paints sheen onto the beach.
		water: [`${prefix}/xyz/water/{z}/{x}/{y}.png`]
	};
}
