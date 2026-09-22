import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tileTemplates } from '#lib/settings/tiles.js';
import { PaneSettings, KNOB_RANGE, readSettings } from '#lib/settings/settings.svelte.js';
import { AeroDisplay } from '#lib/display/display.svelte.js';
import { resolveClearance } from '#lib/display/world/clearance.js';

/**
 * Guards for bugs that have already shipped once and were re-broken by later
 * refactors. Each one cost a real debugging session, and comments alone did not
 * hold — the NAIP guard was removed three separate
 * times before the layer it guarded was itself deleted.
 */

/**
 * Find a source file by name, wherever it currently lives under src/.
 *
 * Deliberately NOT a hardcoded path: this guard has already been silently
 * disabled once by a folder move (display/ → display/world/), which turned a
 * real regression check into an ENOENT. A guard that a refactor can switch off
 * by accident is not a guard.
 */
/** Every .svelte/.ts file under src/, for tree-wide invariants. */
function allSources(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) walk(full);
			else if (/\.(svelte|ts)$/.test(entry)) out.push(full);
		}
	};
	walk('src');
	return out;
}

function findSource(fileName: string, mustContain = ''): string {
	const walk = (dir: string): string | null => {
		for (const entry of readdirSync(dir)) {
			const p = join(dir, entry);
			if (statSync(p).isDirectory()) {
				const hit = walk(p);
				if (hit) return hit;
			} else if (entry === fileName && p.includes(mustContain)) {
				return p;
			}
		}
		return null;
	};

	const found = walk('src');
	if (!found) throw new Error(`${fileName} not found under src/ — was it renamed?`);
	return readFileSync(found, 'utf8');
}

describe('tile URL shape', () => {
	it('keeps the xyz/ segment and the file extension', () => {
		// The route matches `xyz/{layer}/{z}/{x}/{y}.{ext}` and uses it to flip x/y
		// into the on-disk WMTS layout. Drop either part and EVERY tile 404s.
		for (const [layer, tpl] of Object.entries(tileTemplates())) {
			expect(tpl[0], `${layer} must route through /api/tiles`).toContain('/api/tiles/');
			expect(tpl[0], `${layer} needs the xyz/ segment`).toContain('/xyz/');
			// A cache-busting query may follow the extension (viirs carries one
			// because the server tints it), but the extension must still be the
			// last thing in the path — that is what the route splits on.
			expect(tpl[0], `${layer} needs a file extension`).toMatch(/\.(jpg|png)(\?[^/]*)?$/);
		}
	});

	it('never names an upstream host - only api/tiles/+server.ts may do that', () => {
		for (const tpl of Object.values(tileTemplates()).flat()) {
			expect(tpl).not.toMatch(/amazonaws|earthdata|nationalmap/);
		}
	});
});

describe('GroundLayers', () => {
	/**
	 * The guard this replaces asserted the USGS source sat inside an `{#if}` so
	 * it could not fetch while invisible. Refactors removed it three separate
	 * times, which is why it existed at all.
	 *
	 * It then counted `<RasterTileSource>` and demanded exactly two, which was
	 * the right idea measured the wrong way: what killed USGS/NAIP was that it
	 * was a SECOND photograph of the same ground at a resolution the screen
	 * could not resolve, not that it was a third element. Sentinel-2 is also a
	 * second photograph and is emphatically worth having — 10 m against MODIS's
	 * 306 m, and effectively cloudless — so a count is now the wrong question.
	 *
	 * What still matters is that any overlaid source declares the zoom range it
	 * actually holds. USGS's real cost was fetching tiles nobody could see;
	 * Sentinel-2 is packed as per-location boxes, so without `minzoom` MapLibre
	 * would request z0-z7 worldwide and 404 every one. Same failure, so the
	 * guard now checks the thing that prevents it.
	 */
	it('never brings back a redundant high-zoom photograph of the ground', () => {
		const src = findSource('Ground.svelte');
		expect(src).not.toContain('usgs');
		expect(src).not.toContain('naip');
	});

	it('declares a zoom range for the overlaid basemap', () => {
		const src = findSource('Ground.svelte');
		// The sharp layer is a per-location pack, not a global one. Undeclared,
		// its absent zooms become hundreds of 404s a minute.
		expect(src).toMatch(/id="sentinel2"[\s\S]*?minzoom=/);
		expect(src).toMatch(/id="sentinel2"[\s\S]*?maxzoom=/);
	});
});

describe('cache headers match what the artifact actually is', () => {
	/**
	 * A raster tile at z/x/y IS its own address, so a year of `immutable` is
	 * right for it. A PMTiles archive is one URL over 3.7 GB that gets re-packed,
	 * and it is read through hundreds of byte-range requests -- so a stale copy
	 * is not a stale picture, it is a stale DIRECTORY pointing at offsets that
	 * no longer mean what they meant. It carried `immutable` for a year, which
	 * meant a re-packed DEM could not reach a fielded Pi without someone
	 * clearing a browser cache by hand. Flagged in three separate reviews before
	 * it was taken, which is why it is pinned here rather than in a comment.
	 */
	it('never sends immutable for a .pmtiles archive', () => {
		const src = findSource('+server.ts', 'api/tiles');
		const immutableAt = src.indexOf('IMMUTABLE_CACHE =');
		expect(
			immutableAt,
			'the immutable constant should still exist for raster tiles'
		).toBeGreaterThan(-1);
		expect(src, 'pmtiles must be recognised as mutable').toMatch(
			/MUTABLE_ARCHIVE\s*=\s*\/\\\.pmtiles/
		);
		expect(src, 'a mutable archive must revalidate').toContain(
			"REVALIDATE_CACHE = 'public, no-cache'"
		);
		expect(src, 'and must carry a validator to revalidate against').toContain('fileEtag');
	});
});

describe('Sky', () => {
	/**
	 * The starfield is an overlay above the map canvas, masked to the region
	 * above the horizon -- below it there is ground, sea or cloud, and a star
	 * drawn there is a dead pixel.
	 *
	 * The mask read `config.pitchDeg`, the static SETTING, while the frame is
	 * drawn at `view.cameraPitchDeg`, which folds in the bank at BANK_VIEW_GAIN
	 * plus turbulence. The gap was answered by widening the fade band to 12%,
	 * which held only by accident: 0.85 gain against maxBankDeg 14 moves the
	 * horizon +/-10.7% of screen height. Raising maxBankDeg to 18 took it to
	 * +/-13.8% and stars appeared over the ground on every turn -- a tuning
	 * change in one file silently breaking a tolerance in another.
	 */
	it('masks the starfield against the pitch actually rendered', () => {
		const src = findSource('Sky.svelte');
		expect(src, 'the horizon must track the drawn camera, not the setting').toContain(
			'display.view.cameraPitchDeg'
		);
		const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
		expect(code, 'config.pitchDeg does not contain the bank').not.toMatch(
			/horizonPct[\s\S]{0,200}config\.pitchDeg/
		);
	});

	/**
	 * The sky must be identical on three panes, so it is generated from a fixed
	 * seed. It must ALSO look random, and for a long time it did not: each star
	 * re-seeded from its own index as `(i * 9301 + 49297) % 233280`, which with
	 * 9301 coprime to the modulus is an arithmetic progression. 114 of the 139
	 * gaps in x were the same 0.324%, and y/size/opacity were all derived from
	 * that same seed -- an evenly spaced comb whose brightness varied with
	 * position.
	 */
	it('iterates the star generator instead of re-seeding it per star', () => {
		// Comments stripped: this file DESCRIBES the old lattice, and a guard
		// that trips on the explanation of a bug is a guard on prose.
		const code = findSource('Sky.svelte').replace(/\/\*[\s\S]*?\*\//g, '');
		expect(code, 're-seeding from the loop index produces a lattice').not.toMatch(/i \* 9301/);
		expect(code, 'the generator must carry state between stars').toMatch(/seed = \(seed \*/);
	});

	/**
	 * Bank reaches the world as a PITCH offset. It never reaches the map as
	 * roll -- calculateCameraOptionsFromTo derives bearing and pitch from
	 * geometry and nothing sets roll -- so an overlay that rotates with bank is
	 * answering the same input differently from the world behind it.
	 */
	it('does not roll the celestial overlay against a world that stays level', () => {
		const src = findSource('Sky.svelte');
		const css = src.slice(src.indexOf('<style>'));
		expect(css).not.toMatch(/transform:\s*rotate\(var\(--view-bank\)\)/);
	});
});

describe('the plane actually flies', () => {
	/**
	 * A restructure once deleted the frame loop and left `advanceTo()` with no
	 * caller. The view was computed once at construction and never again, so the
	 * window was a still photograph — while type-check, every unit test, the
	 * canvas mount and the console were all perfectly clean. Nothing but two
	 * screenshots five seconds apart could see it.
	 */
	it('drives the camera every frame from the flight pose', () => {
		const src = findSource('Stage.svelte');

		expect(src, 'something must schedule frames').toMatch(/requestAnimationFrame/);
		expect(src, 'each frame must advance the simulation clock').toMatch(/advanceTo\s*\(/);
		expect(src, 'each frame must move the MapLibre camera').toMatch(/jumpTo\s*\(/);
		expect(src, 'camera must be placed by real altitude, not a zoom level').toMatch(
			/calculateCameraOptionsFromTo/
		);
		expect(src, 'the loop must be cancelled on teardown').toMatch(/cancelAnimationFrame/);
	});

	/**
	 * The guard above reads Stage.svelte because Stage.svelte is now the only
	 * renderer. Its twin used to read CesiumStage, which mounted INSTEAD and so
	 * ran none of the loop above -- and Cesium renders continuously whether or
	 * not anyone advances the pose, which is how it sat frozen at its
	 * constructor view while looking perfectly alive.
	 *
	 * That trap belongs to any second renderer, not to Cesium. If one is added,
	 * restore a guard like this one for it: mounting a stage is not the same as
	 * advancing the clock, and only a source scan can tell the difference.
	 */
	it('mounts exactly one stage, so the guard above covers the whole world', () => {
		const src = findSource('Display.svelte');
		expect(src.match(/<Stage\s*\/>/g) ?? [], 'one Stage, unconditionally').toHaveLength(1);
		expect(src, 'a second stage needs its own frame-loop guard').not.toMatch(/Stage\b.*engine/);
	});

	it('does not let map controls fight the frame loop', () => {
		const src = findSource('Stage.svelte');

		// Both are overwritten by the very next frame, because the loop re-derives
		// the whole camera from the pose. Controls must change the params the pose
		// is computed FROM instead.
		expect(src, 'panBy is undone next frame — nudge azimuth instead').not.toMatch(/\.panBy\s*\(/);
		expect(src, 'bind:pitch fights the camera driver').not.toMatch(/bind:pitch/);
	});
});

describe('settings write gate', () => {
	/**
	 * `nudge('azimuthDeg')` wrapped into 0..360 while `applyUrl` and the slider
	 * both used -180..180. One press of "pan left" from the -90 default produced
	 * 255: a legal number, off the end of its own slider, and a different bearing
	 * convention from the one the URL uses. Two copies of a range disagreed.
	 */
	it('keeps azimuth in the same signed range the URL and slider use', () => {
		const s = new PaneSettings();
		s.azimuthDeg = -90;
		s.nudge('azimuthDeg', -15);
		expect(s.azimuthDeg).toBe(-105);

		s.azimuthDeg = -175;
		s.nudge('azimuthDeg', -20); // across the seam
		expect(s.azimuthDeg).toBeGreaterThanOrEqual(-180);
		expect(s.azimuthDeg).toBeLessThanOrEqual(180);
	});

	it('clamps every knob into its declared range', () => {
		const s = new PaneSettings();
		for (const key of Object.keys(KNOB_RANGE) as (keyof typeof KNOB_RANGE)[]) {
			const [lo, hi] = KNOB_RANGE[key];
			s.set(key, hi + 1000);
			expect(s[key], `${key} above max`).toBeLessThanOrEqual(hi);
			s.set(key, lo - 1000);
			expect(s[key], `${key} below min`).toBeGreaterThanOrEqual(lo);
		}
	});

	it('ignores NaN rather than poisoning the pose', () => {
		// A NaN knob makes the camera target NaN, which is a black screen with no
		// error — the same failure mode as the URL parser bug.
		const s = new PaneSettings();
		s.set('shade', Number.NaN);
		expect(Number.isFinite(s.shade)).toBe(true);
	});

	it('has no control anywhere binding straight into config', () => {
		// `bind:` skips the gate: no clamping now, and no validate/merge/broadcast
		// when fleet sync lands, so three panes desync silently. Scans the WHOLE
		// tree rather than one file — the previous version only checked
		// Settings.svelte, so a second panel could reintroduce it unnoticed.
		const offenders: string[] = [];
		for (const file of allSources()) {
			const src = readFileSync(file, 'utf8');
			if (/bind:(value|checked|group)=\{(display\.)?config\./.test(src)) offenders.push(file);
		}
		expect(offenders, 'controls must call config.set(), not bind: into config').toEqual([]);
	});
});

describe('privileged code stays unreachable until it is gated', () => {
	/**
	 * `server/update.ts` schedules `sudo -n systemctl start aero-updater.service`.
	 * aero-2 has no auth layer yet — no `$lib/http/auth`, no AERO_ADMIN_TOKEN
	 * handling — so an /api/update route would be a LAN-wide remote restart.
	 * v1's equivalent route calls `requireAdminToken(request)` first.
	 *
	 * This fails the moment a route imports it without an auth check, which is
	 * exactly the commit where someone would otherwise not think about it.
	 */
	it('no route imports the privileged updater without an auth gate', () => {
		const routes = allSources().filter((f) => f.includes('routes'));
		for (const file of routes) {
			const src = readFileSync(file, 'utf8');
			if (!/server\/update/.test(src)) continue;
			expect(
				/requireAdminToken|AERO_ADMIN_TOKEN/.test(src),
				`${file} runs privileged commands without an auth gate`
			).toBe(true);
		}
	});
});

describe('cloud sprites', () => {
	/**
	 * A THREE.Sprite applies scale in its OWN local axes, so a non-square sprite
	 * that also rotates gets sheared: at 1.3 x 1.0 the apparent aspect runs 1.30
	 * at 0 deg, 1.00 at 45 and 0.77 at 90. The mid-level clouds took a random
	 * full-circle rotation with a 1.3 stretch, so the same square texture
	 * rendered wide, round or squashed purely by its random angle.
	 *
	 * The rule: free rotation OR a stretch, never both. Horizon banks may
	 * stretch because they hold a near-zero roll.
	 */
	it('does not combine a full-circle rotation with a stretched scale', () => {
		const src = findSource('Clouds.svelte');

		// Any sprite scale where x and y differ, other than the horizon banks.
		const stretched = [...src.matchAll(/sprite\.scale\.set\(([^)]*)\)/g)]
			.map((m) => m[1].trim())
			.filter((args) => !args.includes('bankStretch'))
			.filter((args) => {
				const [x, y] = args.split(',').map((a) => a.trim());
				return x !== y;
			});

		expect(stretched, 'freely-rotating cloud sprites must be square').toEqual([]);
	});
});

describe('fog mapping', () => {
	/**
	 * `fog-ground-blend` was `clamp(fogDensity * 2400, 0.65, 0.95)`. Four of the
	 * five bands multiplied out below 0.65, so they were all pinned to the same
	 * value and only the mid deck rose above it — near-constant haze at every
	 * altitude. A high floor here silently erases the whole band model.
	 */
	it('does not floor the fog blend into permanent haze', () => {
		const src = findSource('Sky.svelte');
		const floors = [...src.matchAll(/Math\.max\(\s*([0-9.]+)\s*,/g)]
			.map((m) => Number(m[1]))
			.filter((n) => n > 0.4 && n < 1);
		expect(floors, 'a fog floor above 0.4 hides the altitude bands').toEqual([]);
	});
});

describe('invariant 5 reaches the renderer, not just the tile templates', () => {
	/**
	 * The scan in `tile URL shape` reads `tileTemplates()` -- the MapLibre tile
	 * SSOT -- and asserts none of those names an upstream. It passed for months
	 * while `world/cesium/imagery.ts` hardcoded `tiles.maps.eox.at` and
	 * `tile.openstreetmap.org`, because a template scan cannot see a renderer
	 * that builds its own provider. The invariant read as held; it was not.
	 *
	 * Cesium is deleted, so this starts green with an EMPTY allowlist -- which
	 * is the point. It is not a record of today's offenders, it is the thing
	 * that fails when the next renderer reaches past `/api/tiles`. Media
	 * playlists in `settings/` legitimately name hosts (Unsplash, sample video)
	 * and are out of scope: the rule is about the world, not about demo assets.
	 */
	it('no file under display/ names a network host', () => {
		const offenders: string[] = [];
		for (const file of allSources()) {
			if (!file.includes('lib/display')) continue;
			const raw = readFileSync(file, 'utf8');
			// A comment naming a dead host is documentation, not a fetch.
			const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\s\*).*$/gm, '');
			// The bare protocol, not `https?://[a-z0-9.-]+`. A host is usually
			// interpolated -- `https://${host}/x` and `'https://' + host` both
			// fail a character class right after the slashes, and a template
			// literal is exactly how a tile URL gets built. Nothing under
			// display/ has any business naming a protocol at all, so the
			// stricter test is also the simpler one.
			const m = /https?:\/\//i.exec(code);
			if (m) {
				const line = code.slice(0, m.index).split('\n').length;
				offenders.push(`${file.replace(/^src\/lib\//, '')}:${line}`);
			}
		}
		expect(offenders, 'route it through /api/tiles and name the host in server/tiles.ts').toEqual(
			[]
		);
	});
});

describe('the clamp table is the only range', () => {
	/**
	 * Four sliders carried hardcoded bounds that disagreed with KNOB_RANGE:
	 * speed [0.2,25] vs [0.1,25], exaggeration [0.2,6] vs [0.1,6], and both
	 * wing offsets [-500,500] vs [-800,800]. KNOB_RANGE is what `config.set`
	 * clamps to, so the UI simply could not reach legal values -- a settings
	 * table that is the SSOT for clamping but not for the control is only half
	 * an SSOT.
	 *
	 * Scans for a literal min=/max= on any input whose oninput calls
	 * config.set(), rather than checking the four known ones, so a fifth
	 * cannot be added with hardcoded bounds.
	 */
	it('no slider hardcodes bounds for a knob KNOB_RANGE already defines', () => {
		const src = readFileSync('src/lib/settings/Settings.svelte', 'utf8');
		const offenders: string[] = [];
		const inputs = src.match(/<input\b[\s\S]{0,500}?\/>/g) ?? [];
		for (const input of inputs) {
			const key = /config\.set\('(\w+)'/.exec(input)?.[1];
			if (!key || !(key in KNOB_RANGE)) continue;
			if (/min="[-\d.]+"/.test(input) || /max="[-\d.]+"/.test(input)) offenders.push(key);
		}
		expect(offenders, 'bind min/max to KNOB_RANGE instead of retyping them').toEqual([]);
	});
});

describe('runtime imports are declared dependencies', () => {
	/**
	 * `import('cesium')` shipped while `cesium` was absent from package.json.
	 * The build still succeeded — a dynamic import is resolved at RUNTIME, so
	 * neither `bun run build` nor `svelte-check` can see the gap, and it only
	 * fails on a machine that does not happen to have the package lying around
	 * in node_modules. Measured on ?engine=cesium: 1 uncaught exception.
	 *
	 * Any bare-specifier dynamic import must therefore be a declared dependency.
	 */
	it('every dynamically imported package is in package.json', () => {
		const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
		const declared = new Set([
			...Object.keys(pkg.dependencies ?? {}),
			...Object.keys(pkg.devDependencies ?? {})
		]);

		const undeclared = new Set<string>();
		for (const file of allSources()) {
			const src = readFileSync(file, 'utf8');
			for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
				const spec = m[1];
				// Relative paths and subpath aliases resolve locally.
				if (spec.startsWith('.') || spec.startsWith('#') || spec.startsWith('$')) continue;
				const pkgName = spec.startsWith('@')
					? spec.split('/').slice(0, 2).join('/')
					: spec.split('/')[0];
				if (!declared.has(pkgName)) undeclared.add(`${pkgName} (${file})`);
			}
		}

		expect(
			[...undeclared],
			'a dynamic import of an undeclared package builds fine and fails on a clean install'
		).toEqual([]);
	});
});

describe('three panes stay in step', () => {
	/**
	 * Three Pi 5s form ONE window and exchange nothing about what they draw, so
	 * every visible effect has to be a pure function of the wall clock. A single
	 * `Math.random()` in a render path splits the wall: the director rolled its
	 * own rotation interval and put three cities on three panes, and the storm
	 * lightning rolled its own delay and flashed at three different moments.
	 *
	 * Audio is exempt — it is one speaker, not three panes — and comments are
	 * not code.
	 */
	it('has no Math.random in anything that draws', () => {
		const offenders: string[] = [];
		for (const file of allSources()) {
			if (file.includes('/media/')) continue; // audio noise buffer, not visual
			const src = readFileSync(file, 'utf8');
			// strip block and line comments before looking
			const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
			if (/Math\.random\s*\(/.test(code)) offenders.push(file);
		}
		expect(offenders, 'use slotNoise/daySeed — a random draw desyncs the wall').toEqual([]);
	});

	/**
	 * The rule above only bans the obvious desync source. This one asserts the
	 * property it exists to protect: the same wall second, place and role must
	 * produce the same pose, twice, on a cold model. Any accumulator — a
	 * `+= dt`, a cached previous frame, a value seeded at construction — passes
	 * the Math.random scan and fails here, because the second model has no
	 * history to accumulate from and the first one does.
	 */
	it('derives the same pose from the same second, with no history', () => {
		const at = 1_767_000_000; // any fixed wall second
		const pose = (d: AeroDisplay) => {
			d.advanceTo(at - 30); // give the first model a past the second lacks
			d.advanceTo(at - 1);
			return d.advanceTo(at);
		};

		const a = pose(new AeroDisplay(readSettings(new URL('http://kiosk.local/?place=denver'))));
		const b = new AeroDisplay(readSettings(new URL('http://kiosk.local/?place=denver'))).advanceTo(
			at
		);

		expect(b).toEqual(a);
	});

	/**
	 * A DEM tile that has not decoded must not be able to lower the camera. The
	 * old expression `Math.max(mean, sample ?? 0)` agrees on land but routes
	 * "unknown" through literal sea level, and reports nothing.
	 */
	it('falls back to the regional mean when terrain does not answer, and says so', () => {
		expect(resolveClearance(1600, undefined)).toEqual({ groundM: 1600, sampled: false });
		expect(resolveClearance(1600, NaN)).toEqual({ groundM: 1600, sampled: false });
		expect(resolveClearance(1600, 4200)).toEqual({ groundM: 4200, sampled: true });
		// A real sample below the regional mean is still a measurement.
		expect(resolveClearance(1600, 900)).toEqual({ groundM: 1600, sampled: true });
	});
});

describe('routes render something', () => {
	/**
	 * /admin once shipped as a completely blank page. `bun run check` was green,
	 * every unit test passed, and the kiosk route looked perfect — because a
	 * single throw during component init produces an empty <body>, and with SSR
	 * off the server still answers 200. Nothing but loading the page can see it.
	 *
	 * It happened AGAIN here: the page declared a /api/status shape the endpoint
	 * does not send, so `status?.memory.heapUsedMb` optional-chained the wrong
	 * link and threw once the fetch resolved. 200 OK, 19 characters of text.
	 *
	 * This is now a BACKSTOP rather than the primary guard. The response shape
	 * lives in one place (`lib/status.ts`), the endpoint writes `satisfies
	 * KioskStatus` and both readers import the type, so the drift that caused
	 * the blank page is a failed type-check first. This still runs the endpoint
	 * and compares real keys, which a type cannot do.
	 */
	it('admin only reads fields /api/status actually sends', async () => {
		const { GET } = await import('../src/routes/api/status/+server.js');
		const res = await GET({} as never);
		const payload = await res.json();
		const known = new Set(Object.keys(payload));

		// Comments explain the bug this guards, so they name the very field that
		// must not appear. Strip them before matching, or the fix trips its own test.
		const src = findSource('+page.svelte', 'admin')
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/\/\/.*$/gm, '')
			/**
			 * ...and imports, or the module path `#lib/status.js` reads as a field
			 * access on `status` and the guard fails on its own fix.
			 *
			 * Spans lines. The single-line form missed a MULTI-LINE import — the
			 * closing `} from '#lib/status.js';` survived on its own and matched
			 * as `status?.js`, so adding one more named import to that statement
			 * failed this test with an invented field called "js". A false
			 * positive on a backstop is worse than none: it trains the next
			 * person to widen the filter rather than read the failure.
			 */
			.replace(/^\s*import\b[\s\S]*?from\s*['"][^'"]*['"];?$/gm, '')
			.replace(/^\s*import .*$/gm, '');
		const read = [...src.matchAll(/status[?]?\.([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1]);

		const invented = [...new Set(read)].filter((k) => !known.has(k));
		expect(invented, 'admin reads fields /api/status does not return').toEqual([]);
	});
});

describe('/admin is not public by default', () => {
	/**
	 * /admin renders the kiosk hostname, LAN addresses, memory and uptime, and
	 * links every pane role — a device fingerprint plus a remote control, with
	 * no auth. It is gated by a server load, opt-in via AERO_ADMIN_UI.
	 *
	 * Easy to mis-test: `ssr = false` means GET /admin returns 200 regardless,
	 * because that is the static shell served before any load runs. The guard
	 * fires on the data request. Test the load function directly.
	 *
	 * THIS BLOCK USED TO ASSERT THE BUG. It set `NODE_ENV=production`, checked
	 * the throw, then set `development` and checked the page rendered — both
	 * green against a guard that read `NODE_ENV === 'production'` and therefore
	 * served the full cockpit for every OTHER value, including unset, which is
	 * what a Pi boots with and what `smoke-routes.mjs` calls "the Pi's own
	 * configuration". The test covered the two configurations someone thought
	 * of and never the default, so a fail-open guard read as tested.
	 *
	 * The table is the fix: enumerate what a device can actually boot with, and
	 * assert the surface is CLOSED for all of it bar one explicit opt-in.
	 */
	const load = async () => (await import('../src/routes/admin/+page.server.js')).load;

	const withEnv = async (env: Record<string, string | undefined>, fn: () => void) => {
		const prev: Record<string, string | undefined> = {};
		for (const [k, v] of Object.entries(env)) {
			prev[k] = process.env[k];
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try {
			fn();
		} finally {
			for (const [k, v] of Object.entries(prev)) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	};

	// Everything a fielded device can plausibly boot with. Unset is first
	// because it is the one that was open.
	const CLOSED: [string, Record<string, string | undefined>][] = [
		['nothing set at all', { NODE_ENV: undefined, AERO_ADMIN_UI: undefined }],
		['NODE_ENV=production', { NODE_ENV: 'production', AERO_ADMIN_UI: undefined }],
		['NODE_ENV=development', { NODE_ENV: 'development', AERO_ADMIN_UI: undefined }],
		['the flag explicitly off', { NODE_ENV: undefined, AERO_ADMIN_UI: '0' }],
		['the flag set to a truthy-looking string', { NODE_ENV: undefined, AERO_ADMIN_UI: 'true' }],
		['the flag empty', { NODE_ENV: undefined, AERO_ADMIN_UI: '' }]
	];

	for (const [label, env] of CLOSED) {
		it(`404s with ${label}`, async () => {
			const fn = await load();
			await withEnv(env, () => {
				expect(() => fn(), 'the cockpit must be closed unless opted in').toThrow();
			});
		});
	}

	it('renders only with AERO_ADMIN_UI=1', async () => {
		const fn = await load();
		await withEnv({ NODE_ENV: undefined, AERO_ADMIN_UI: '1' }, () => {
			expect(() => fn()).not.toThrow();
		});
	});

	it('does not leak every interface from /api/status', async () => {
		// allIps included loopback and any internal/VPN interface. lanIps is the
		// narrower set the admin page actually needs.
		const { GET } = await import('../src/routes/api/status/+server.js');
		const payload = await (await GET({} as never)).json();
		for (const leaky of ['allIps', 'arch', 'platform', 'loadAvg']) {
			expect(payload, `${leaky} is a fingerprint, not telemetry`).not.toHaveProperty(leaky);
		}
	});
});

describe('an explicit ?place= is not overridden by the rotation', () => {
	/**
	 * `?place=hyderabad` loaded Hyderabad and then the director's clock-derived
	 * slot moved the window elsewhere a second later, so the URL looked like it
	 * did nothing. That is worse than a cosmetic bug: every place-specific check
	 * — terrain clearance, tile coverage, a screenshot taken to verify a fix —
	 * silently tests whichever location the rotation happened to pick.
	 *
	 * Caught by asking for Hyderabad and screenshotting the Himalayas.
	 */
	it('pins the destination when the URL names one', () => {
		const pinned = readSettings(new URL('http://kiosk.local/?place=denver'));
		expect(pinned.place.id).toBe('denver');
		expect(pinned.rotate, 'a named place must stop the rotation').toBe(false);
	});

	it('pins the destination when the URL names a preset that has one', () => {
		const pinned = readSettings(new URL('http://kiosk.local/?preset=gulf-midnight'));
		expect(pinned.place.id, 'the preset names Dubai').toBe('dubai');
		expect(pinned.rotate, "a preset's clock offset is measured against ITS place").toBe(false);
	});

	it('still rotates when the URL names no place', () => {
		const free = readSettings(new URL('http://kiosk.local/'));
		expect(free.rotate).toBe(true);
	});
});

describe('a served dataset has a renderer', () => {
	/**
	 * `data/roads/` was 46 MB of packed OSM geometry, served by
	 * `/api/roads/[city]` with ETag validation and covered by `geojson.test.ts`
	 * — and drawn by NOTHING. Every part worked except that no component ever
	 * asked for it, so nothing anywhere could go red: the endpoint answered
	 * 200, the tests passed, the health check does not look at `data/`, and the
	 * kiosk rendered a city with no lights on it and no error.
	 *
	 * That is the recurring shape in this repo (ARCHITECTURE §5): an asset that
	 * is present, plausible and inert. `REQUIRED_TILE_ASSETS` fixed it for the
	 * raster archive by asserting NAMED assets rather than counting
	 * directories; this is the same assertion pointed the other way, at the
	 * GeoJSON endpoints — if the server offers a dataset kind, some component
	 * under `display/` must fetch it.
	 *
	 * Deliberately a source scan and not a mount: the point is to fail when the
	 * NEXT dataset is packaged and wired up to nothing, which is a question
	 * about the tree, not about a running frame. `probe-layers.mjs` is what
	 * proves the layer actually paints.
	 */
	it('every /api/<kind>/[city] endpoint has a consumer under display/', () => {
		const kinds = allSources()
			.filter((f) => /routes\/api\/[a-z]+\/\[city\]\/\+server\.ts$/.test(f))
			.map((f) => f.match(/routes\/api\/([a-z]+)\//)![1]);
		expect(kinds.length, 'expected the buildings and roads endpoints').toBeGreaterThan(1);

		// Comments stripped, exactly as the upstream-host scan above does and
		// for the same reason: this file's own docstring NAMES `/api/roads/`
		// while explaining the bug, which made the test pass against a
		// deliberately broken fetch. A doc reference is not a consumer.
		const display = allSources()
			.filter((f) => f.includes('lib/display'))
			.map((f) =>
				readFileSync(f, 'utf8')
					.replace(/\/\*[\s\S]*?\*\//g, '')
					.replace(/^\s*(\/\/|\s\*).*$/gm, '')
			)
			.join('\n');

		const orphans = kinds.filter((kind) => !display.includes(`/api/${kind}/`));
		expect(orphans, 'packed, served, and drawn by nothing — give it a layer').toEqual([]);
	});
});

/**
 * The three invariants ARCHITECTURE.md marked "—" for enforcement.
 *
 * All three were TRUE when this was written, and none of them was checked. That
 * is the most expensive state for a rule to be in: it reads as settled, so it
 * gets cited in review and relied on in design, while nothing stops the commit
 * that ends it. This repo has already recorded the same shape twice — "no
 * import cycles" was documented while `sim` and `stage` imported each other,
 * and determinism was claimed in a docstring by a cloud deck integrating frame
 * deltas in three places. A rule nobody enforces is a rule nobody keeps.
 *
 * These are cheap because the codebase already complies; they exist to keep it
 * that way.
 */
describe('architecture invariants that were documented but unenforced', () => {
	/** #7 — no barrel files. */
	it('has no index.ts barrels', () => {
		const barrels = allSources().filter((f) => /(^|\/)index\.ts$/.test(f));
		expect(
			barrels,
			'a barrel re-exports a whole directory, so one import pulls the lot and ' +
				'tree-shaking stops working — and it hides where a symbol actually lives'
		).toEqual([]);
	});

	/**
	 * #3 — context DI, one root.
	 *
	 * `createDisplay()` builds the model; `useDisplay()` reads it from context.
	 * A second `createDisplay()` call site is a second model: two poses, two
	 * clocks, and a pane whose HUD disagrees with its own window. Components
	 * must take the context, never construct their own.
	 */
	it('constructs the display model in exactly one place', () => {
		const callers = allSources().filter((f) => {
			// The module that DEFINES it is not a caller of it.
			if (f.endsWith('lib/display/display.svelte.ts')) return false;
			const src = readFileSync(f, 'utf8')
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.replace(/^\s*(\/\/|\s\*).*$/gm, '');
			// An import names it; a call invokes it. Only the call makes a model.
			return /\bcreateDisplay\s*\(/.test(src.replace(/^\s*import[\s\S]*?;$/gm, ''));
		});
		expect(callers, 'exactly one root may construct the model').toEqual([
			'src/routes/+page.svelte'
		]);
	});

	/**
	 * #6 — the 3D world runs inside an error boundary.
	 *
	 * Without it a WebGL throw during init takes the whole page down to an empty
	 * <body> served with a 200 — the exact failure `smoke-routes` exists to
	 * catch, and the one the parent repo shipped on /admin with 489 green tests.
	 * The boundary is what turns a dead kiosk into a degraded one.
	 */
	it('wraps the stage in a svelte:boundary', () => {
		const display = readFileSync('src/lib/display/Display.svelte', 'utf8');
		const body = display.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|\s\*).*$/gm, '');
		expect(body, 'a WebGL throw must degrade the pane, not blank the page').toContain(
			'<svelte:boundary'
		);
	});
});
