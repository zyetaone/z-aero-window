/**
 * Tile server helpers — TILE_DIR resolution, path guard, PMTiles Range parsing, and LAN CORS.
 */
import { createReadStream, existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// ── TILE_DIR Discovery ────────────────────────────────────────────────────────

/**
 * `data/tiles`, NOT `static/tiles`.
 *
 * The pack lived under `static/` until 2026-09-03, which handed 56,182 files
 * and 9.7 GB to Vite's static copy: every build duplicated and brotli-
 * compressed the whole archive into `build/client/tiles`, taking 3.5 minutes
 * and leaving an 11 GB build directory beside the 9.7 GB source — two copies
 * of the same tiles on a Pi's SD card.
 *
 * The subtler cost was that it made invariant 5 optional. A copy under
 * `static/` is served by the adapter's own file handler, so
 * `GET /tiles/terrain.pmtiles` answered 200 without passing the path guard,
 * the symlink check, the Range parser or the CORS policy in this file. The
 * archive has to sit somewhere Vite does not walk for /api/tiles to be the
 * only door.
 */

function dirHasLayers(dir: string): boolean {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.some((e) => {
				try {
					return readdirSync(resolve(dir, e.name)).length > 0;
				} catch {
					return false;
				}
			});
	} catch {
		return false;
	}
}

export function resolveTileDir(
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
	piDirExists: (path: string) => boolean = existsSync,
	dirHasContent: (path: string) => boolean = dirHasLayers
): string {
	if (env.TILE_DIR) return resolve(cwd, env.TILE_DIR);
	const piPath = '/opt/zyeta-aero/tiles';
	if (piDirExists(piPath)) return piPath;

	const local = resolve(cwd, 'data/tiles');
	if (dirHasContent(local)) return local;

	const parent = resolve(cwd, '../data/tiles');
	if (dirHasContent(parent)) return parent;

	return local;
}

// ── Tile Path Shape ───────────────────────────────────────────────────────────

const WMTS_TILE_PATH =
	/^(?<layer>[a-z0-9-]+)\/(?<z>\d+)\/(?<y>\d+)\/(?<x>\d+)\.(?<ext>jpg|jpeg|png)$/;

// ── Archive Health ────────────────────────────────────────────────────────────

/**
 * What the archive must actually CONTAIN for the window to draw the world.
 *
 * This is deliberately NOT the same list as `settings/tiles.ts`'s
 * `tileTemplates`, and the difference is the whole point. `terrarium/` is a
 * directory of raw PNG heightmaps that `tools/pack-pmtiles.ts` reads to BUILD
 * `terrain.pmtiles`; the running kiosk never requests it. So a pack shipping
 * terrarium and nothing else is 3.6 GB of build input with no ground colour and
 * no DEM — exactly the state this repo was in on 2026-09-03, while
 * `/api/tiles/health` reported `{"status":"ok","hasTiles":true}` because it
 * counted any non-empty directory.
 *
 * `fatal` separates a blank window from a dimmer one: without `gibs` the ground
 * is a white sheet, without the DEM the world is a flat ellipsoid. `viirs` only
 * adds city lights after dark, so its absence is worth REPORTING and not worth
 * failing over.
 *
 * It lives HERE rather than beside the templates because `server/` imports
 * nothing from `settings/` or `display/` (architecture §1), and because the
 * templates describe URLs while this describes disk. They will drift only if a
 * new raster source is added, which is the moment to read both.
 */
const REQUIRED_TILE_ASSETS = [
	{ name: 'gibs', path: 'gibs', kind: 'dir', fatal: true },
	{ name: 'terrain.pmtiles', path: 'terrain.pmtiles', kind: 'file', fatal: true },
	{ name: 'viirs', path: 'viirs', kind: 'dir', fatal: false },
	/**
	 * The sharp basemap. Non-fatal because MODIS still draws a world without it
	 * — just a 306 m/px one — and because it is packed per location, so a device
	 * provisioned for a subset of the catalog is a legitimate state rather than
	 * a broken pack.
	 */
	{ name: 'sentinel2', path: 'sentinel2', kind: 'dir', fatal: false },
	/**
	 * The water mask. Non-fatal for the same reason as `sentinel2`: it is packed
	 * per location, so a device provisioned for a subset of the catalogue is a
	 * legitimate state rather than a broken pack, and without it the window
	 * simply draws water as the flat photograph it always did.
	 *
	 * Listed at all because of the note above: an archive can only report a
	 * missing asset it has been told to look for. This layer spent a week
	 * packed, served and mounted by nothing precisely because no check knew it
	 * should exist.
	 */
	{ name: 'water', path: 'water', kind: 'dir', fatal: false }
] as const satisfies readonly {
	name: string;
	path: string;
	kind: 'dir' | 'file';
	fatal: boolean;
}[];

export interface TileHealth {
	/**
	 * Three states, not a boolean, because "no night lights" and "no ground"
	 * are not the same emergency and were previously the same word.
	 */
	status: 'ok' | 'degraded' | 'error';
	/** No FATAL asset is missing — i.e. the window can draw a world. */
	hasTiles: boolean;
	/** What is actually on disk. Diagnostic; not what correctness is judged on. */
	layers: string[];
	/** Named assets from REQUIRED_TILE_ASSETS that are absent. Says what to pack. */
	missing: string[];
	/**
	 * Directories on disk that the kiosk never requests, largest first.
	 *
	 * Dead weight is invisible otherwise, and it is not small: `_s2-hyderabad`
	 * is 2.7 GB of raw Sentinel GeoTIFFs left behind by an abandoned warp, and
	 * `terrarium/` is 3.6 GB of build INPUT that `pack-pmtiles` already turned
	 * into `terrain.pmtiles`. Together that is 6.3 GB — more than half the pack
	 * — on a device whose whole budget is an SD card. Both previously counted
	 * as `layers`, so the health readout presented them as assets.
	 *
	 * Reported, never deleted: this endpoint has no business removing 6 GB
	 * because it did not recognise a name, and `terrarium/` is genuinely needed
	 * on whatever machine repacks the DEM.
	 */
	unused: { name: string; bytes: number }[];
	remoteFallback: boolean;
}

/**
 * Does the archive hold what the running style requests?
 *
 * Takes `root` rather than reading the module-level TILE_DIR so the suite can
 * point it at a temp directory containing a deliberately incomplete pack. The
 * bug being prevented here is precisely one of "the check could not fail", so
 * a check that cannot be tested against a broken archive is not an improvement.
 */
export function resolveTileHealth(root: string, env: NodeJS.ProcessEnv = process.env): TileHealth {
	const dir = root.replace(/\/+$/, '') + '/';

	let layers: string[] = [];
	try {
		layers = readdirSync(dir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.filter((name) => {
				try {
					return readdirSync(resolve(dir, name)).length > 0;
				} catch {
					return false;
				}
			});
	} catch {
		/* TILE_DIR absent entirely — every asset reports missing below. */
	}

	const present = (asset: (typeof REQUIRED_TILE_ASSETS)[number]): boolean => {
		try {
			const stats = statSync(resolve(dir, asset.path));
			// A zero-byte terrain.pmtiles and an empty gibs/ both exist and both
			// draw nothing. Existence is not the question; content is.
			return asset.kind === 'dir'
				? stats.isDirectory() && readdirSync(resolve(dir, asset.path)).length > 0
				: stats.isFile() && stats.size > 0;
		} catch {
			return false;
		}
	};

	const missing = REQUIRED_TILE_ASSETS.filter((a) => !present(a)).map((a) => a.name);
	const fatalMissing = REQUIRED_TILE_ASSETS.some((a) => a.fatal && missing.includes(a.name));
	const fallback = remoteFallbackEnabled(env);

	/**
	 * Anything on disk that no requested layer maps to.
	 *
	 * Shallow: it sums the immediate children of each directory rather than
	 * walking the whole tree, because this runs on a health check against a
	 * 10 GB archive and an exact byte count is not worth a full stat walk. The
	 * figure is for spotting gigabytes, not for accounting.
	 */
	const known = new Set<string>(REQUIRED_TILE_ASSETS.map((a) => a.path));
	// Build input, not a served layer: pack-pmtiles reads it to make the DEM.
	known.add('terrarium');
	const unused = layers
		.filter((name) => !known.has(name))
		.map((name) => {
			let bytes = 0;
			try {
				for (const entry of readdirSync(resolve(dir, name), { withFileTypes: true })) {
					try {
						bytes += entry.isFile() ? statSync(resolve(dir, name, entry.name)).size : 0;
					} catch {
						/* vanished mid-scan */
					}
				}
			} catch {
				/* unreadable */
			}
			return { name, bytes };
		})
		.sort((a, b) => b.bytes - a.bytes);

	/**
	 * A dev box with the remote fallback on draws the world without a single
	 * local tile, so `error` there would be a false alarm on the one machine
	 * where nothing is actually broken. It reports `degraded` — the pack IS
	 * incomplete — while the Pi, where the fallback is off, reports `error`.
	 */
	const status: TileHealth['status'] = fatalMissing
		? fallback
			? 'degraded'
			: 'error'
		: missing.length > 0
			? 'degraded'
			: 'ok';

	return { status, hasTiles: !fatalMissing, layers, missing, unused, remoteFallback: fallback };
}

// ── Remote Fallback (Dev Only) ────────────────────────────────────────────────

export function remoteFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.AERO_TILE_REMOTE_FALLBACK === '0') return false;
	if (env.AERO_TILE_REMOTE_FALLBACK === '1') return true;
	return env.NODE_ENV === 'development';
}

/**
 * The MODIS day the imagery is frozen to. NOT `default`, which means "today".
 *
 * Three reasons, in order of how badly each bit:
 *
 * 1. MODIS true colour is a same-day swath, so it shows the weather. Asking
 *    for today over Hyderabad in August returns 99.5% cloud — the window goes
 *    white. A pinned clear day is the only way this reads as a view.
 * 2. Some days have no tile at all over a given city (2025-10-28 and
 *    2026-05-06 both return nothing over Denver). `default` gambles on that
 *    every midnight.
 * 3. Determinism. Three Pis booting either side of the GIBS daily update would
 *    fetch different rasters, and the panorama would disagree across the seam.
 *
 * TWO bars, and every earlier pin cleared only the first.
 *
 * COVERAGE is the gate: a day with no tile over a location renders a black
 * void under a lit sky. 2026-04-15 was picked when the catalog held only
 * Hyderabad and Denver and is genuinely clear over both, but it 404s over the
 * Sahara; 08-20 misses Mumbai. Both scored 10/11.
 *
 * CLARITY is the tiebreak, and is what 08-23 missed. It was 11/11 and pinned
 * on that basis, but a covered tile can still be solid CLOUD, and that is what
 * made the window white. It took a while to believe: the fog colour, the
 * hillshade, the raster grade, the cloud deck and the CSS overlays were each
 * disabled in turn with no effect, and the ground stayed white even with
 * `setSky(null)`, terrain off and every layer but the base raster hidden.
 * White that survives deleting the sky, and has ground texture in it, is the
 * photograph. Sampling the packed tiles confirmed it — over Denver the tile
 * directly overhead was dark (lum 66) while the ones a few hundred km west,
 * which fill most of the frame, were 145-157.
 *
 * Sweep over z6-z9, weighted by how many tiles the window requests at each
 * level (logged from a real orbit: roughly 1:2:3:3), +/-3 tiles out. Three
 * earlier passes each measured too narrow a slice, and each produced a
 * confident wrong answer:
 *
 *   z8 near the centre  -> scored a day 13.1% that is really ~40%
 *   z6 alone            -> rated only the widest tiles
 *   +/-1 tile           -> passed 06-19 at 11/11, which rendered a BLACK WEDGE
 *                          over the Pacific from six missing z9 tiles a few
 *                          hundred km off the pin
 *
 * On the current metric:
 *
 *   07-02 42.2% ELIGIBLE   06-19 REJECT (ocean)   07-15 REJECT (hyderabad)
 *   07-03 REJECT (desert, mumbai)   06-20 REJECT (hyderabad)
 *   08-23 REJECT (las vegas)
 *
 * The REJECTs are the point. Coverage holes are common, narrow, and off-centre,
 * and a missing tile is a black void under a lit sky — strictly worse than
 * cloud. 07-02 is the only candidate swept so far that is clean everywhere the
 * window looks; it is NOT the clearest, and that is the gate working.
 *
 * ~42% is the honest state of the source. MODIS true colour is a same-day
 * swath, so there is no clear day to find; changing dates moves this a few
 * points and cannot do better.
 *
 * The RIGHT fix is a cloudless COMPOSITE. EOX s2cloudless-2024 measures 4.6%
 * washed at 11/11 coverage on this same weighted z6-z9 metric — 6x better than
 * the best eligible MODIS day, verified by pointing this switch at it and
 * re-rendering Denver/Dallas/Chicago (Dallas ground luminance 171 -> 122). It is not used because it is
 * CC BY-NC-SA (non-commercial) and this is a paid installation; the parent repo
 * accepts that licence, we cannot. The commercial-safe route is the same
 * Sentinel-2 data from the public AWS `sentinel-cogs` bucket under Copernicus,
 * which needs a packaging pipeline rather than a URL swap.
 *
 * To re-pin: `python3 tools/survey-gibs-date.py <dates...>`, discard anything
 * that is not 11/11, then take the lowest washed percentage. Expect ~40%; a
 * candidate that looks dramatically better usually means the tool has stopped
 * sampling the zooms or the area the renderer draws. Run a date TWICE before
 * rejecting it — a timed-out tile used to be reported as missing imagery, which
 * fabricated coverage gaps and scored 07-01 both 11/11 and 10/11 minutes apart.
 * After re-pinning, repack and drive every location: the survey samples a grid,
 * the orbit does not.
 */
export const GIBS_DATE = '2026-07-02';

/**
 * VIIRS day/night band — the city-lights raster, for night.
 *
 * Pinned for the same reason GIBS_DATE is, and the layer and date must move
 * together: this is a daily product, so three Pis booting either side of the
 * update would light the cities differently across the panorama seam. The
 * gap-filled BRDF-corrected variant is the one that is usable as a picture —
 * the raw radiance band is speckled with orphan bright pixels.
 *
 * GoogleMapsCompatible_Level8 is the whole pyramid: there is no z9+. That is
 * fine, because it is a glow laid under the horizon haze, not detail.
 */
const VIIRS_LAYER = 'VIIRS_NOAA20_GapFilled_BRDF_Corrected_DayNightBand_Radiance';
const VIIRS_DATE = '2026-07-15';

export function remoteTileUrl(subPath: string): string | null {
	const m = subPath.match(WMTS_TILE_PATH);
	if (!m?.groups) return null;
	const { layer, z, y, x } = m.groups;
	switch (layer) {
		case 'terrarium':
			return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
		case 'gibs':
			return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${GIBS_DATE}/GoogleMapsCompatible_Level9/${z}/${y}/${x}.jpg`;
		case 'viirs':
			return `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${VIIRS_LAYER}/default/${VIIRS_DATE}/GoogleMapsCompatible_Level8/${z}/${y}/${x}.png`;
		/**
		 * `sentinel2` has NO upstream, deliberately.
		 *
		 * There is no public XYZ endpoint serving the Sentinel-2 pixels under a
		 * commercially usable licence — EOX serves exactly this imagery and is
		 * CC BY-NC-SA, which is the whole reason this layer is built locally from
		 * `sentinel-cogs` by `tools/fetch-sentinel2.py`. Returning null means a
		 * missing tile stays a 404 rather than silently falling back to a source
		 * we are not licensed for, which is the failure mode worth engineering
		 * against: a dev box quietly proxying non-commercial imagery would look
		 * perfect right up until it shipped.
		 *
		 * The consequence is intended: outside the packed boxes the window draws
		 * MODIS, and `Ground.svelte` mounts sentinel2 as an overlay above it.
		 */
		default:
			return null;
	}
}

// ── Range Requests (PMTiles) ──────────────────────────────────────────────────

export interface ByteRange {
	start: number;
	end: number;
}

export function parseRange(
	header: string | null,
	size: number
): ByteRange | null | 'unsatisfiable' {
	if (!header) return null;
	const m = header.match(/^bytes=(\d*)-(\d*)$/);
	if (!m) return null;
	const [, rawStart, rawEnd] = m;
	if (rawStart === '' && rawEnd === '') return null;

	// A zero-length file satisfies no range at all. Without this, `bytes=-100`
	// against an empty file returned `{ start: 0, end: -1 }` -- which the route
	// turns into `Content-Range: bytes 0--1/0` and a read stream with a negative
	// end. The suffix branch never reached the `end < start` check below.
	if (size === 0) return 'unsatisfiable';

	if (rawStart === '') {
		const suffix = Number(rawEnd);
		if (suffix <= 0) return 'unsatisfiable';
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}

	const start = Number(rawStart);
	if (start >= size) return 'unsatisfiable';
	const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
	if (end < start) return 'unsatisfiable';
	return { start, end };
}
