/**
 * Every upstream origin this product talks to, and the licence each one carries.
 *
 * ONE file answers "what does a fielded device fetch, and are we allowed to?".
 * Before this, seven files across `src/`, `tools/` and `scripts/` each named
 * their own host, and the consequence was not theoretical: ESRI World Imagery
 * (proprietary) and CartoDB (Enterprise-only for commercial use) were both
 * bulk-cached to disk and shipped, and removing ESRI meant editing six files
 * in three directories. A licence question that has to be answered by grep gets
 * answered wrongly, or not at all.
 *
 * Deliberately dependency-free — no browser APIs, no Cesium, no Svelte. That is
 * load-bearing: the bun packager scripts import this too, and the reason the
 * VIIRS layer + date were previously duplicated (see
 * tests/tools/tile-packager/viirs-source-pinning.test.ts) was that the only
 * shared home for them was a browser module full of canvas code. There is now
 * a home with no such problem.
 *
 * `commercial: false` means the free tier does NOT cover a paid installation.
 * Such a source may only be used behind a licence we actually hold — it is not
 * a "free basemap" because the endpoint answers without a key.
 */

export interface UpstreamSource {
  /** Tile URL template, `{z}`/`{x}`/`{y}` in the order the host expects. */
  readonly url: string;
  readonly licence: string;
  /** Does the free/open tier cover a commercial kiosk installation? */
  readonly commercial: boolean;
  readonly attribution: string;
}

// ── Elevation ─────────────────────────────────────────────────────────────────

export const AWS_TERRARIUM: UpstreamSource = {
  url: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
  licence: "Public domain (Mapzen / AWS Open Data)",
  commercial: true,
  attribution: "Elevation: Mapzen / AWS Open Data",
};

// ── Night lights ──────────────────────────────────────────────────────────────

/**
 * Layer and date are pinned together and MUST NOT drift: three Pis booting
 * either side of midnight UTC would otherwise fetch different rasters, and the
 * panorama would disagree across the seam. Pinning also keeps the packaged
 * tiles and the remote fallback byte-identical.
 *
 * To re-pin: choose a date, verify coverage across the whole location catalog
 * (a single day can be gap-filled unevenly by region), then change it HERE —
 * both the runtime and the packager read this, so there is only one place.
 */
export const VIIRS_GIBS_LAYER =
  "VIIRS_NOAA20_GapFilled_BRDF_Corrected_DayNightBand_Radiance";
export const VIIRS_GIBS_DATE = "2026-07-15";

export const VIIRS_GIBS_BASE = `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${VIIRS_GIBS_LAYER}/default/${VIIRS_GIBS_DATE}/GoogleMapsCompatible_Level8`;

export const GIBS_VIIRS: UpstreamSource = {
  url: `${VIIRS_GIBS_BASE}/{z}/{y}/{x}.png`,
  licence: "Public domain (NASA EOSDIS GIBS)",
  commercial: true,
  attribution: "Night lights: NASA EOSDIS GIBS (VIIRS)",
};

// ── Satellite colour ──────────────────────────────────────────────────────────

/**
 * EOX Sentinel-2 cloudless. NOT commercially licensed on the free tier.
 *
 * This is the current default basemap and it is the one open question in the
 * stack: the imagery is right (a natural cloudless composite, which is why it
 * was chosen), but CC BY-NC-SA does not cover a paid installation. The clean
 * replacement is the same Sentinel-2 data from the public AWS `sentinel-cogs`
 * bucket under the Copernicus licence, which does permit commercial use.
 */
export const COPERNICUS_SENTINEL2: UpstreamSource = {
  // Not a tile URL: the pack is BUILT from Level-2A COGs (aero-2/tools) and
  // served from disk as `sentinel2/{z}/{y}/{x}.jpg`. Nothing fetches this
  // at runtime.
  url: "s3://sentinel-cogs/sentinel-s2-l2a-cogs/{mgrs}/{date}/",
  licence: "Copernicus Sentinel data — commercial use permitted, attribution required",
  commercial: true,
  attribution: "Contains modified Copernicus Sentinel data 2026",
};

/** Dev-machine fallback only. Never packaged, never fielded. */
export const EOX_SENTINEL2: UpstreamSource = {
  url: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg",
  licence: "CC BY-NC-SA 4.0 — NON-COMMERCIAL",
  commercial: false,
  attribution:
    "Imagery: Sentinel-2 cloudless by EOX IT Services GmbH (CC BY-NC-SA 4.0)",
};

/** Mapbox Satellite. Commercial use is fine — under YOUR account's own terms. */
export const MAPBOX_SATELLITE_URL =
  "https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg90?access_token=";

// ── Vector road geometry ──────────────────────────────────────────────────────

/**
 * Overpass mirrors, tried in order. Build-time only — the fielded device never
 * calls these; it reads the baked GeoJSON in `data/roads/`.
 *
 * `fetch()` sends no User-Agent, and Overpass answers a bare request with 406,
 * which reads as throttling and is not. Send one.
 */
export const OVERPASS_MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
] as const;

export const OSM_LICENCE = "ODbL — © OpenStreetMap contributors";

// ── Removed, and staying removed ──────────────────────────────────────────────

/**
 * Sources deleted for licence reasons. Listed so the next person reaching for a
 * "free" basemap finds the answer here instead of rediscovering the endpoint.
 *
 * - ESRI World Imagery (`server.arcgisonline.com/.../World_Imagery`) —
 *   proprietary (Maxar/Airbus via Esri). Free tier is non-commercial; bulk
 *   caching to disk is outside it either way. Removed 2026-08-26.
 * - CartoDB `dark_nolabels` (`basemaps.cartocdn.com`) — Enterprise-only for
 *   commercial use. Was 132 MB of a 139 MB tile cache. Replaced by ODbL vector
 *   roads in `world/roads-geojson.ts`.
 */
export const REMOVED_SOURCES = ["esri-world-imagery", "cartodb-dark"] as const;
