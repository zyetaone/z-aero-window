/**
 * Integration assertions — the seams, not the units.
 *
 * The unit suite is healthy and was green through every failure it should have
 * caught. That is not a paradox: each component passed its own test while the
 * JOIN between components was broken. The DEM was packed correctly, served
 * correctly and decoded correctly by hand, yet the map read sea level. The
 * Sentinel-2 warp exited 0 and wrote nothing. The Cesium engine had a settings
 * field, a switch and a component, and no dependency.
 *
 * Everything here therefore asserts a property that spans a boundary, and each
 * one is written against a failure that actually happened.
 */
import { describe, it, expect, vi } from 'vitest';
import {
	existsSync,
	openSync,
	readSync,
	closeSync,
	readFileSync,
	readdirSync,
	statSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { calculateCameraView } from '#lib/display/flight/view.js';
import { resolveAtmosphere } from '#lib/display/world/atmosphere.js';
import { sunPosition, nightAmount } from '#lib/display/world/sun.js';
import { Location } from '#lib/locations.js';
import {
	tileTemplates,
	TILE_MAXZOOM,
	SENTINEL2_PLACES,
	WATER_PLACES
} from '#lib/settings/tiles.js';
import { remoteTileUrl, resolveTileDir } from '#lib/server/tiles.js';
import { WALL_KEYS } from '#lib/wall.js';

/** Comments name these hazards to explain them; only real code counts. */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function simSources(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) walk(full);
			else if (/\.(ts|svelte)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
		}
	};
	walk('src/lib/display');
	walk('src/lib/settings');
	return out;
}

// ── 1. The product invariant ─────────────────────────────────────────────────

/**
 * Three Pi 5s stand side by side and exchange nothing. The panorama only holds
 * if the entire world is a pure function of (wall clock, place, daySeed) — so
 * two independently built panes fed identical inputs must agree exactly, not
 * approximately.
 *
 * This is asserted over a whole climb cycle rather than at one instant, because
 * the ways it breaks are cumulative: an accumulator that integrates `dt`, or a
 * value seeded from boot time, agrees on the first frame and diverges later.
 * That is exactly how the cloud deck drifted apart — it was seeded per pane and
 * its rotation was `+=` off `performance.now()`, so panes agreed at a glance
 * and disagreed after an hour of uptime.
 */
describe('the world is a pure function of (wallclock, place, daySeed)', () => {
	const paramsFor = (place: Location) => ({
		place: {
			lat: place.lat,
			lon: place.lon,
			utcOffset: place.utcOffset,
			isFeature: place.isFeature
		},
		azimuthDeg: 0,
		pitchDeg: -18,
		floorM: place.climbFloorM,
		ceilingM: place.climbCeilingM,
		direction: 1 as const,
		speed: 4.0
	});

	it('two independently built panes agree exactly across a full cycle', () => {
		for (const place of Location.all()) {
			const a = paramsFor(place);
			const b = paramsFor(place);

			for (let s = 0; s < 3600; s += 37) {
				const va = calculateCameraView(s, a);
				const vb = calculateCameraView(s, b);
				expect(vb, `${place.id} diverged at t=${s}s`).toEqual(va);
			}
		}
	});

	/**
	 * The view for a given wall-clock second must not depend on WHEN it is
	 * computed.
	 *
	 * The first draft of this test asserted `sunPosition(s, ...)` equalled
	 * `sunPosition(s, ...)` — a call compared to itself, which passes for any
	 * deterministic body and proves nothing. The property that actually matters
	 * is that no ambient clock leaks in: three panes evaluate the same second at
	 * three slightly different real instants, and a stray `Date.now()` anywhere
	 * in the chain would make them disagree.
	 *
	 * `Location.utcOffset` deliberately reads the current instant, because DST
	 * is a function of today's date — so the two probes sit a minute apart,
	 * inside any DST regime, where a correct implementation cannot differ and a
	 * leaky one must.
	 */
	it('does not depend on when it is evaluated', () => {
		const AT = Date.UTC(2026, 6, 15, 12, 0, 0);
		vi.useFakeTimers();
		try {
			for (const place of Location.all()) {
				vi.setSystemTime(AT);
				const early = [0, 917, 4321].map((s) => ({
					view: calculateCameraView(s, paramsFor(place)),
					sun: sunPosition(s, place.lat, place.utcOffset)
				}));

				vi.setSystemTime(AT + 60_000);
				const late = [0, 917, 4321].map((s) => ({
					view: calculateCameraView(s, paramsFor(place)),
					sun: sunPosition(s, place.lat, place.utcOffset)
				}));

				expect(late, `${place.id} reads an ambient clock`).toEqual(early);
			}
		} finally {
			vi.useRealTimers();
		}
	});

	/**
	 * Night and atmosphere are the two curves the whole look hangs off, so pin
	 * their SHAPE rather than re-deriving them: midnight must be fully night,
	 * midday fully day, and the sky must darken monotonically as it climbs.
	 * A tautology here would hide a constant.
	 */
	it('keeps the night and atmosphere curves the right way up', () => {
		expect(nightAmount(-30)).toBeCloseTo(1, 2); // sun well down
		expect(nightAmount(60)).toBeCloseTo(0, 2); // sun high
		expect(nightAmount(-30)).toBeGreaterThan(nightAmount(0));

		const luma = (agl: number) => {
			const [r, g, b] = resolveAtmosphere(agl).skyTop;
			return r + g + b;
		};
		expect(luma(11_000)).toBeLessThan(luma(500));
	});

	/**
	 * `Math.random()` and `+= dt` are the two shapes that split the wall, and
	 * neither is visible to the assertions above — they live in canvas render
	 * loops and timers, not in the view DTO. A source scan is the only thing
	 * that sees them, and it is the same technique regressions.test.ts already
	 * uses for upstream hosts, `bind:` into config and privileged imports.
	 *
	 * ALLOWED is for randomness that is genuinely per-pane and cosmetic: audio
	 * noise is not visual at all, and rain droplets on the glass are foreground
	 * cabin detail rather than shared world.
	 *
	 * It briefly carried a KNOWN list too, for director.svelte.ts, which rolled
	 * an unseeded 2-5 minute timer and advanced the DESTINATION on it. That debt
	 * is paid — the destination is derived from the wall clock now — so the list
	 * is gone rather than kept empty against future use.
	 */
	const ALLOWED = [
		'display/media/ambient-audio.ts', // white-noise buffer; audio, not world
		'display/cabin/RainGlass.svelte' // droplets on this pane's own glass
	];

	it('has no unseeded randomness in the simulation path', () => {
		const offenders: string[] = [];
		for (const file of simSources()) {
			const rel = file.replace(/^src\/lib\//, '');
			if (ALLOWED.some((a) => rel.endsWith(a))) continue;
			const src = readFileSync(file, 'utf8');
			// A comment naming the hazard is how this codebase documents it.
			const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
			if (/Math\.random\s*\(/.test(code)) offenders.push(rel);
		}
		expect(offenders, 'seed from daySeed, or add to ALLOWED with a reason').toEqual([]);
	});
});

/**
 * ADR-007's actual thesis, made enforceable.
 *
 * The ADR's root-cause finding was TWO MUTATION PATHS: a control that wrote
 * config locally AND pushed, so the two could disagree and something had to
 * merge them. The fix is not a better merge, it is one path — and "one path" is
 * a property of where code lives, which no unit test can see. Same technique as
 * the `Math.random` and `+= dt` scans above.
 *
 * A wall key assigned anywhere but the two files that own it is that second
 * path reappearing. `Settings.svelte` is the operator drawer and is allowed to
 * write pane-local knobs; the moment it writes a WALL key directly instead of
 * drafting and pushing, this fails.
 */
describe("ADR-007's one mutation path is structural, not documented", () => {
	const OWNERS = ['settings/wall.svelte.ts', 'settings/settings.svelte.ts'];

	/**
	 * The four that exist today, and what each one means.
	 *
	 * None is a bug right now — nothing pushes a wall snapshot yet, so each is
	 * the ONLY writer of its key and there is nothing to disagree with. They
	 * become the second path the moment the Wall drawer tab ships, and each then
	 * needs a decision rather than a refactor:
	 *
	 *   use-blind / MediaStage — a touch on the glass and a video reaching its
	 *     end are local events with an immediate local answer. Probably stay,
	 *     with last-writer-wins against a push, which ADR-007 already accepts.
	 *   Settings.svelte — the operator drawer writing a wall key directly is the
	 *     exact shape ADR-007 named as root cause. These two move into the Wall
	 *     tab's local draft, which POSTs instead of assigning.
	 *
	 * Listed rather than allowed: a new entry fails this test, and removing one
	 * means editing this list on purpose. The Math.random scan above carried a
	 * KNOWN list the same way until its debt was paid, then dropped it.
	 */
	const KNOWN = [
		'display/cabin/use-blind.svelte.ts (blindOpen)',
		'display/media/MediaStage.svelte (displayMode)',
		'settings/Settings.svelte (blindOpen)'
	];

	it('writes a wall key onto config nowhere but its owners and the known three', () => {
		const offenders: string[] = [];
		for (const file of simSources()) {
			const rel = file.replace(/^src\/lib\//, '');
			if (OWNERS.some((o) => rel.endsWith(o))) continue;
			const code = stripComments(readFileSync(file, 'utf8'));
			for (const key of WALL_KEYS) {
				// `config.weather =` — an assignment onto the shared sink. `==`, `===`
				// and `>=` must not match; a component's own local state is not this.
				if (new RegExp(`config\\.${key}\\s*=(?!=)`).test(code)) offenders.push(`${rel} (${key})`);
			}
		}
		expect(
			offenders.sort(),
			'draft locally and POST /api/wall — do not assign a wall key onto config'
		).toEqual([...KNOWN].sort());
	});
});

/**
 * Two invariants ARCHITECTURE.md states and nothing enforced.
 *
 * Both were violated in the tree the day this was written, and neither showed
 * up in a unit test, because both are properties of where code lives rather
 * than of what any function returns. The source scan above already proved the
 * technique works for `Math.random`.
 */
describe('the architecture invariants are actually held', () => {
	/**
	 * Invariant 2: wall-clock time is the only input to the world, so three
	 * panes agree without a protocol.
	 *
	 * `Math.random` is the obvious half and is covered above. The other half is
	 * an accumulator: `x += dt` integrates each pane's own frame drops, and a
	 * clamp like `Math.min(0.1, dt)` silently discards the overflow, so the
	 * value runs slower than the clock by an amount that differs per pane and
	 * resets on reboot. That is how the director split the wall, and the cloud
	 * deck was doing it in three places while its own docstring claimed
	 * determinism. Derive from `view.wallSec` instead.
	 */
	it('integrates no frame deltas in the simulation path', () => {
		const offenders: string[] = [];
		for (const file of simSources()) {
			const rel = file.replace(/^src\/lib\//, '');
			const code = stripComments(readFileSync(file, 'utf8'));
			// `foo += dt`, `foo += delta * n`, `foo += elapsed`, and friends.
			const m = /(\w+)\s*\+=\s*[^;\n]*\b(dt|delta|deltaMs|elapsed|frameTime)\b/.exec(code);
			if (m) offenders.push(`${rel} (${m[0].trim()})`);
		}
		expect(offenders, 'derive from view.wallSec, not from an accumulator').toEqual([]);
	});

	/**
	 * Invariant 4, in the form that is actually true and worth enforcing.
	 *
	 * The doc claimed "only display/world/ imports MapLibre", which was never
	 * so -- MiniMap renders a map and needs one, and LookControls mounts a
	 * MapLibre control. Contorting those buys nothing.
	 *
	 * What does matter is that the PURE modules stay pure: the flight model,
	 * the camera, the atmosphere and the sun are the layer a second renderer
	 * has to reuse unchanged, and they are the layer the tests can exercise
	 * without a GPU. One renderer import in any of them and both properties are
	 * gone, which is how a "swappable engine" quietly stops being swappable.
	 */
	const PURE_MODULES = [
		'src/lib/display/flight/flight-path.ts',
		'src/lib/display/flight/view.ts',
		'src/lib/display/flight/parallax.ts',
		'src/lib/display/world/atmosphere.ts',
		'src/lib/display/world/sun.ts',
		'src/lib/settings/settings.svelte.ts',
		'src/lib/locations.ts'
	];

	it('keeps the pure simulation modules free of any renderer', () => {
		const offenders: string[] = [];
		for (const file of PURE_MODULES) {
			const code = stripComments(readFileSync(file, 'utf8'));
			// `import type` is erased at build time and costs nothing at runtime.
			for (const line of code.split('\n')) {
				if (!/^\s*import\s/.test(line) || /^\s*import\s+type\s/.test(line)) continue;
				if (/'(maplibre-gl|svelte-maplibre-gl|cesium|three)/.test(line))
					offenders.push(`${file}: ${line.trim()}`);
			}
		}
		expect(offenders, 'the pure layer is what a second renderer reuses').toEqual([]);
	});
});

// ── 2. The elevation pipeline ────────────────────────────────────────────────

/**
 * PMTiles v3 header: bounds live at fixed offsets as int32 micro-degrees, and
 * the zoom range as two bytes. Parsed directly rather than pulling in a reader,
 * because 24 bytes at known offsets is not worth a dependency.
 */
function readPmtilesHeader(path: string) {
	const fd = openSync(path, 'r');
	const buf = Buffer.alloc(127);
	readSync(fd, buf, 0, 127, 0);
	closeSync(fd);
	if (buf.subarray(0, 7).toString() !== 'PMTiles')
		throw new Error(`${path} is not a PMTiles archive`);
	return {
		version: buf.readUInt8(7),
		minzoom: buf.readUInt8(100),
		maxzoom: buf.readUInt8(101),
		minLon: buf.readInt32LE(102) / 1e7,
		minLat: buf.readInt32LE(106) / 1e7,
		maxLon: buf.readInt32LE(110) / 1e7,
		maxLat: buf.readInt32LE(114) / 1e7
	};
}

/**
 * `/data` is gitignored, so this cannot be a hard requirement — a test that
 * reads data/** passes locally and takes the deploy gate red, which has
 * happened before. Skipped with a message rather than silently, so a skip in
 * CI is legible and a skip on a workstation is a prompt to build the archive.
 */
describe('the packed DEM covers every location that needs it', () => {
	// Through `resolveTileDir`, not a literal path. This was `static/tiles/…`
	// and kept working by coincidence until the archive moved to `data/`, at
	// which point both assertions started SKIPPING rather than failing — the
	// quietest way for a coverage test to stop covering anything. Asking the
	// resolver means the suite looks wherever the server looks.
	const ARCHIVE = resolve(resolveTileDir(), 'terrain.pmtiles');
	const present = existsSync(ARCHIVE);

	it.skipIf(!present)('reaches every location in the catalog', () => {
		const h = readPmtilesHeader(ARCHIVE);

		// The orbit is ~47 km across and the view reaches well past it, so the
		// centre alone is not enough — require a degree of margin on each side.
		const MARGIN_DEG = 1.0;
		const missing = Location.all()
			.filter(
				(l) =>
					l.lon - MARGIN_DEG < h.minLon ||
					l.lon + MARGIN_DEG > h.maxLon ||
					l.lat - MARGIN_DEG < h.minLat ||
					l.lat + MARGIN_DEG > h.maxLat
			)
			.map((l) => `${l.id} (${l.lat.toFixed(2)}, ${l.lon.toFixed(2)})`);

		// The Himalayas sat at 86.9E against an archive that stopped at 79.9E,
		// so the DEM was simply absent there and the window showed no relief.
		// It looked like a rendering bug for hours. It was a packaging gap, and
		// this is the one line that would have said so.
		//
		// NOTE what this cannot see. The header is one rectangle around every
		// tile in the archive, and the archive is a set of per-location BOXES —
		// so the bbox spans -179.7..88.2E and 16..85N while being empty across
		// almost all of it. A location inside the bbox may have no tile at all.
		// The DEM is packed to roughly +/-1 deg around each pin, and the camera
		// roams further than that, so this passing means very little on its own.
		// `queryTerrainElevation` returns 0 for an absent tile, which reads as
		// sea level and is invisible. Coverage is measured properly by the
		// pmtiles reader, not here; see AeroDisplay.terrain / terrainSampledPct
		// for the runtime signal.
		expect(missing, `outside archive bounds — repack: bun tools/pack-pmtiles.ts terrarium`).toEqual(
			[]
		);
	});

	it.skipIf(!present)('declares the zoom range the runtime asks for', () => {
		const h = readPmtilesHeader(ARCHIVE);
		expect(h.version).toBe(3);
		// A source that requests beyond the archive gets tiles that never
		// resolve, and MapLibre reports missing elevation as 0 — which is
		// indistinguishable from sea level at the call site.
		expect(h.maxzoom).toBe(TILE_MAXZOOM.terrarium);
		expect(h.minzoom).toBeLessThanOrEqual(5);
	});
});

// ── 3. Every source the style names must be one the server can answer ────────

/**
 * `Ground.svelte` mounts sources from `tileTemplates()`; the server answers
 * them in `remoteTileUrl`. Nothing tied the two together, so a layer could name
 * a slug the server had never heard of and the only symptom would be tiles that
 * quietly never arrive — which is exactly how an invisible USGS layer streamed
 * 404s by the hundred over Hyderabad.
 */
describe('every tile source the client names, the server can serve', () => {
	/**
	 * Layers with no upstream, and why that is correct rather than an omission.
	 *
	 * `sentinel2` is built offline from the `sentinel-cogs` bucket by
	 * `tools/fetch-sentinel2.py`. There IS a public XYZ service for this exact
	 * imagery — EOX s2cloudless — and it is CC BY-NC-SA, so wiring it as a
	 * fallback would mean a dev box silently proxying non-commercial pixels and
	 * looking perfect right up until it shipped. `remoteTileUrl` returning null
	 * is the licence boundary, so this list is a deliberate exemption, not a
	 * hole in the check.
	 *
	 * `water` is the same shape for a different reason: it is DERIVED, not
	 * fetched. `tools/fetch-water-mask.py` reclassifies the Sentinel-2 Scene
	 * Classification band into a binary mask, so there is no upstream serving
	 * these pixels to fall back to — nobody publishes "class 6 of this scene as
	 * a PNG". It is also not in `download-tiles.ts`'s LAYER_EXT for the same
	 * reason `sentinel2` is not: that table describes tile-by-tile WMTS
	 * downloads, and this layer is warped and cut by GDAL.
	 */
	const NO_UPSTREAM = new Set(['sentinel2', 'water']);

	it('resolves each template slug to an upstream URL', () => {
		const templates = tileTemplates();
		for (const [slug, urls] of Object.entries(templates)) {
			expect(urls.length, `${slug} has no template`).toBeGreaterThan(0);

			// The client asks in xyz form and the server answers in WMTS form;
			// the extension has to survive that hop, so take it from the
			// template the client actually mounts rather than assuming one.
			// A cache-busting query may trail the extension (viirs carries one
			// because the server tints it, so z/x/y is no longer the whole
			// address); the extension is still what the route splits on.
			const ext = /\.(jpg|jpeg|png)(\?[^/]*)?$/.exec(urls[0])?.[1];
			expect(ext, `${slug} template declares no image extension`).toBeTruthy();

			const built = remoteTileUrl(`${slug}/4/3/2.${ext}`);
			if (NO_UPSTREAM.has(slug)) {
				expect(built, `"${slug}" is packed offline and must NOT have a remote fallback`).toBeNull();
				continue;
			}
			expect(built, `server cannot resolve slug "${slug}"`).toBeTruthy();
			expect(built, `"${slug}" must resolve to an absolute upstream`).toMatch(/^https?:\/\//);
		}
	});

	it('declares a maxzoom for every slug it serves', () => {
		for (const slug of Object.keys(tileTemplates())) {
			expect(
				TILE_MAXZOOM[slug as keyof typeof TILE_MAXZOOM],
				`${slug} has no declared maxzoom, so the client will overzoom into 404s`
			).toBeGreaterThan(0);
		}
	});

	/**
	 * The PACKAGER has to write the extension the client asks for.
	 *
	 * `tools/download-tiles.ts` chose it with
	 * `layer === 'terrarium' ? 'png' : 'jpg'`, so `viirs` — a PNG layer,
	 * because city lights need alpha over the base imagery — was written as
	 * `.jpg`. GIBS ignores the extension in the request, so every fetch
	 * SUCCEEDED: the tool reported "542 downloaded, 0 failed" while writing
	 * 4,534 files at paths the server never looks up. The kiosk 404'd on all
	 * of them and the packager said the pack was complete.
	 *
	 * A third failure of the same shape as the two above it in this file: an
	 * absence that reports as success. Read out of the source rather than
	 * re-declared here, because a copy of the table would agree with itself.
	 */
	it('the packager writes the extension each layer is requested with', () => {
		const src = readFileSync('tools/download-tiles.ts', 'utf8');
		const table = /const LAYER_EXT = \{([^}]*)\}/.exec(src);
		expect(table, 'download-tiles.ts no longer declares LAYER_EXT').toBeTruthy();

		const packed = Object.fromEntries(
			[...table![1].matchAll(/(\w+):\s*'(\w+)'/g)].map((m) => [m[1], m[2]])
		);

		for (const [slug, urls] of Object.entries(tileTemplates())) {
			// `sentinel2` is not fetched tile-by-tile from an XYZ host; it is warped
			// and cut from COGs by `tools/fetch-sentinel2.py`, which writes .jpg
			// through gdal2tiles. Demanding an entry in a table that only describes
			// WMTS downloads would be asserting the wrong tool owns it.
			if (NO_UPSTREAM.has(slug)) continue;
			const wanted = /\.(jpg|jpeg|png)(\?[^/]*)?$/.exec(urls[0])?.[1];
			expect(packed[slug], `packager has no extension for "${slug}"`).toBeTruthy();
			expect(
				packed[slug],
				`packager writes ${slug} as .${packed[slug]} but the client requests .${wanted}`
			).toBe(wanted);
		}
	});

	/**
	 * The offline packager must write the layout the server reads.
	 *
	 * `gdal2tiles --xyz` emits `{z}/{x}/{y}`; `WMTS_TILE_PATH` in
	 * `server/tiles.ts` reads `{z}/{y}/{x}`. Both get called "XYZ", and on a
	 * square grid the two are indistinguishable by eye — the first Denver pack
	 * came out transposed, so every tile 404'd while the directory looked
	 * perfectly plausible and the tool reported success.
	 */
	/**
	 * The gate must match the archive.
	 *
	 * `SENTINEL2_PLACES` decides whether the source mounts at all, and it is a
	 * hand-kept list beside a directory of `source-<place>.json` files. A name
	 * in the list with no pack behind it is a request storm — unmounted, the
	 * Pacific was firing 203 sentinel2 requests in 16 seconds and 404ing every
	 * one. A pack with no name is 50 MB of imagery nothing ever draws.
	 *
	 * Skipped rather than failed when `data/` is absent, like the DEM checks
	 * above: the archive is gitignored, so a hard requirement would take CI red
	 * for a file CI is not supposed to have.
	 */
	const s2Dir = resolve(resolveTileDir(), 'sentinel2');
	const s2Packed = existsSync(s2Dir);

	it.skipIf(!s2Packed)('gates the sharp basemap on what is actually packed', () => {
		const onDisk = readdirSync(s2Dir)
			.map((f) => /^source-(.+)\.json$/.exec(f)?.[1])
			.filter((v): v is string => Boolean(v))
			.sort();
		expect(onDisk.length, 'no sentinel2 packs found at all').toBeGreaterThan(0);
		expect([...SENTINEL2_PLACES].sort()).toEqual(onDisk);
	});

	/**
	 * Same rule for the water mask, which had no such check.
	 *
	 * `SENTINEL2_PLACES` has been guarded since it was written; `WATER_PLACES`
	 * sat one export below it with only a "keep in step with data/tiles/water/"
	 * comment, and a comment is not a check. Packing Dubai and Mumbai meant
	 * editing both lists, and only one of them could tell me I had forgotten.
	 * The failure it prevents is identical: a name with no pack is a 404 storm,
	 * a pack with no name is a layer nothing draws.
	 */
	const waterDir = resolve(resolveTileDir(), 'water');
	const waterPacked = existsSync(waterDir);

	it.skipIf(!waterPacked)('gates the water mask on what is actually packed', () => {
		const onDisk = readdirSync(waterDir)
			.map((f) => /^source-(.+)\.json$/.exec(f)?.[1])
			.filter((v): v is string => Boolean(v))
			.sort();
		expect(onDisk.length, 'no water packs found at all').toBeGreaterThan(0);
		expect([...WATER_PLACES].sort()).toEqual(onDisk);
	});

	it.skipIf(!s2Packed)('records the commercial licence with every pack', () => {
		// The Copernicus terms permit commercial use and REQUIRE attribution.
		// EOX s2cloudless serves these same pixels and is CC BY-NC-SA, so a pack
		// that cannot say where it came from is a pack nobody can clear.
		for (const f of readdirSync(s2Dir).filter((n) => n.startsWith('source-'))) {
			const meta = JSON.parse(readFileSync(resolve(s2Dir, f), 'utf8'));
			expect(meta.licence, `${f} records no licence`).toMatch(/Copernicus/i);
		}
	});

	/**
	 * Every pack must be REACHABLE at its own coordinates.
	 *
	 * The two checks above passed while three of seven packs were unusable:
	 * they confirm a pack is listed and licensed, not that the server can find
	 * a single tile of it. `transpose_to_wmts` used to flip the whole shared
	 * layer tree, so packing a second place re-transposed the first place back
	 * into gdal2tiles order — Hyderabad had a complete archive on disk and
	 * served 129 404s and zero hits.
	 *
	 * Nothing in the suite could see it, because the failure is a filename
	 * convention: `11/923/1469.jpg` and `11/1469/923.jpg` both look like tiles.
	 * So compute the tile the location actually sits on and require it to exist
	 * the way the server asks for it.
	 */
	it.skipIf(!s2Packed)('files every pack at coordinates the server can resolve', () => {
		const Z = 11;
		const n = 2 ** Z;
		const wrongWayRound: string[] = [];
		const missing: string[] = [];

		for (const f of readdirSync(s2Dir).filter((x) => x.startsWith('source-'))) {
			const meta = JSON.parse(readFileSync(resolve(s2Dir, f), 'utf8'));
			const [w, s2, e, n2] = meta.bbox as number[];
			const lon = (w + e) / 2;
			const lat = (s2 + n2) / 2;
			const x = Math.floor(((lon + 180) / 360) * n);
			const rad = (lat * Math.PI) / 180;
			const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);

			// {z}/{y}/{x} is what WMTS_TILE_PATH reads.
			if (existsSync(resolve(s2Dir, String(Z), String(y), `${x}.jpg`))) continue;
			// {z}/{x}/{y} means the transpose was skipped or applied twice.
			if (existsSync(resolve(s2Dir, String(Z), String(x), `${y}.jpg`))) {
				wrongWayRound.push(meta.place);
			} else {
				missing.push(meta.place);
			}
		}

		expect(wrongWayRound, 'packs stored {z}/{x}/{y}; the server reads {z}/{y}/{x}').toEqual([]);
		expect(missing, 'packs with no tile over their own centre').toEqual([]);
	});

	/**
	 * A pack must be COMPLETE, not merely present at its centre.
	 *
	 * The check above samples one tile per pack, and that is exactly as much as
	 * it caught: after the transposed packs were repaired it went green while
	 * three of them were still missing ~75% of their z8-11 tier. The repair had
	 * filtered by the near bbox recorded in the metadata, so it re-filed the
	 * high zooms and left the wide ones where the server could not see them —
	 * a hole in the far field, which is most of the frame at cruise.
	 *
	 * So sample the CORNERS as well as the centre, at both tiers. Cheap, and it
	 * fails on exactly the shape a partial repair leaves behind.
	 */
	it.skipIf(!s2Packed)('packs cover their whole declared extent, not just the centre', () => {
		// Mirrors WIDE_MARGIN_DEG / WIDE_MAX_ZOOM and the near box in
		// tools/fetch-sentinel2.py. Duplicated because the tool is standalone
		// Python; if those change, this is the second place to look.
		const ORBIT = 0.25;
		const ASPECT = 1.7;
		const tiers: [number, number][] = [
			[10, 1.2],
			[13, 0.4]
		];
		const holes: string[] = [];

		for (const f of readdirSync(s2Dir).filter((x) => x.startsWith('source-'))) {
			const meta = JSON.parse(readFileSync(resolve(s2Dir, f), 'utf8'));
			const [w, s2, e, n2] = meta.bbox as number[];
			const clon = (w + e) / 2;
			const clat = (s2 + n2) / 2;

			for (const [z, margin] of tiers) {
				const n = 2 ** z;
				const dlat = ORBIT + margin;
				const dlon = ORBIT * ASPECT + margin;
				const tile = (lon: number, lat: number) => {
					const rad = (lat * Math.PI) / 180;
					return {
						x: Math.floor(((lon + 180) / 360) * n),
						y: Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)
					};
				};
				// Inset one tile: the extreme edge can legitimately fall outside
				// what gdal2tiles emitted for a bbox that lands mid-tile.
				const lo = tile(clon - dlon, clat - dlat);
				const hi = tile(clon + dlon, clat + dlat);
				const xs = [Math.min(lo.x, hi.x) + 1, Math.max(lo.x, hi.x) - 1];
				const ys = [Math.min(lo.y, hi.y) + 1, Math.max(lo.y, hi.y) - 1];

				for (const x of xs) {
					for (const y of ys) {
						if (!existsSync(resolve(s2Dir, String(z), String(y), `${x}.jpg`))) {
							holes.push(`${meta.place} z${z} ${y}/${x}`);
						}
					}
				}
			}
		}

		expect(holes, 'packs missing tiles at the corners of their declared extent').toEqual([]);
	});

	it('the sentinel-2 packager transposes gdal2tiles output to the served layout', () => {
		const src = readFileSync('tools/fetch-sentinel2.py', 'utf8');
		expect(src, 'gdal2tiles still emits {z}/{x}/{y}').toContain('--xyz');
		expect(
			src.includes('transpose_to_wmts(tiles_dir'),
			'tiles are left in gdal2tiles order, which the server cannot read'
		).toBe(true);
	});
});
