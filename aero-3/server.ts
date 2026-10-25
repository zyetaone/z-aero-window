/**
 * aero-3's whole server: the page, the tiles off local disk, and the wall an
 * operator pushes to every pane (`/admin`, src/ops/wall.ts).
 *
 * Bun bundles `index.html` and everything it imports (no Vite, no SvelteKit),
 * and the `{ dir }` routes serve the tile trees with content types and range
 * handling built in. They refuse `..`, so no path guard is needed here. Both
 * trees are the ones aero-1 and aero-2 already ship, stored `{z}/{y}/{x}`.
 *
 * Defaults resolve from the working directory, not `import.meta.dir`: inside a
 * `--compile`d binary that is the embedded filesystem, where no tiles live.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { readdir, rename } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import index from './index.html';
import admin from './admin.html';
import { LEAD_SEC, MAX_PUSH_BYTES, MEDIA_ID, NO_WALL, parsePush, type Wall } from './src/ops/wall.ts';
import { WeatherCache } from './src/ops/live-weather.ts';
import { MAX_DEVICES, MAX_HEARTBEAT_BYTES, parseHeartbeat, type FleetRow } from './src/ops/fleet.ts';

const IMAGERY_DIR = Bun.env.IMAGERY_DIR ?? '../data/tiles/sentinel2';
const TERRAIN_DIR = Bun.env.TERRAIN_DIR ?? '../aero-2/data/tiles/terrarium';
const LIGHTS_DIR = Bun.env.LIGHTS_DIR ?? '../aero-2/data/tiles/viirs';
// Written by `python3 ../aero-2/tools/fetch-buildings.py <place> --radius 3500 --max-features 20000 --out .`
const BUILDINGS_DIR = Bun.env.BUILDINGS_DIR ?? './data/buildings';
// The road packs aero-1 and aero-2 already ship (aero-1/tools/tile-packager/src/roads.ts), stamped with class.
const ROADS_DIR = Bun.env.ROADS_DIR ?? '../data/roads';
// Operator-uploaded music and clips (/api/media): created at boot so the static route below always mounts.
const MEDIA_DIR = Bun.env.MEDIA_DIR ?? './data/media';
mkdirSync(MEDIA_DIR, { recursive: true });
// One file, multipart/form-data, refused on the declared length first (aero-2's lesson:
// formData() buffers the whole body, so checking after means already paying for it).
const MEDIA_MB = Number(Bun.env.AERO_MEDIA_MB ?? 50);
const MAX_MEDIA_BYTES = (Number.isFinite(MEDIA_MB) && MEDIA_MB > 0 ? MEDIA_MB : 50) * 1024 * 1024;
/** Bare store names: no slashes, no dotfiles, audio/video extensions only. */
const MEDIA_EXTS = ['.mp3', '.wav', '.ogg', '.mp4', '.webm'];
const mediaName = (raw: string) => {
	const base = raw.split('/').pop()!.split('\\').pop()!;
	if (!MEDIA_ID.test(base) || base.startsWith('.') || base.includes('..')) return null;
	if (!MEDIA_EXTS.some((ext) => base.toLowerCase().endsWith(ext))) return null;
	return base;
};
// aero-2's 737 wing, ~1 MB: CC-BY-4.0, by "A Random Modeler" on Sketchfab (credited in src/wing.ts).
const MODELS_DIR = Bun.env.MODELS_DIR ?? '../aero-2/static/models';
// The wall (src/ops/wall.ts): what the operator last pushed, kept across restarts.
const WALL_FILE = Bun.env.WALL_FILE ?? './data/wall.json';
// Fails closed: with no token set, nothing can push.
const ADMIN_TOKEN = Bun.env.AERO_ADMIN_TOKEN ?? '';
// Each Pi's health-check.sh heartbeat to the wall Pi: a lower-privilege token than the admin one.
const FLEET_TOKEN = Bun.env.AERO_FLEET_TOKEN ?? '';
const fleet = new Map<string, FleetRow>();
// What this pane's page last measured (POST /api/fps from the kiosk on this machine), and the
// last error it threw (POST /api/error), for the heartbeat.
let fps = 0;
let lastError = '';
// The checkout the updater put here; health-check.sh reports it.
const COMMIT = Bun.env.AERO_COMMIT ?? Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { stderr: 'ignore' }).stdout.toString().trim();
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
// A compiled binary runs from Bun's embedded filesystem: never dev mode on a Pi, NODE_ENV or not.
const DEV = Bun.env.NODE_ENV !== 'production' && !import.meta.path.startsWith('/$bunfs');
const stored = (await Bun.file(WALL_FILE).json().catch(() => null)) as Wall | null;
// A wall from an older release (a place renamed, a regime gone) must not read as "nothing pushed"
// while its version counts on: keep the number, drop the scene.
let wall: Wall = stored && parsePush(stored) && Number.isFinite(stored.version) ? stored : { ...NO_WALL, version: Number(stored?.version) || 0 };
// deploy/pi/health-check.sh writes the Pi's temperature and shed state here every few minutes.
const THERMAL_FILE = Bun.env.AERO_THERMAL_STATE_PATH ?? '/run/aero/thermal.json';
const startedAt = Date.now();
// This device's LAN address, for the kiosk's admin QR (a phone cannot reach "localhost"). Per
// request: on a Pi the network can come up after the server.
const lan = () => Object.values(networkInterfaces()).flat().find((a) => a?.family === 'IPv4' && !a.internal)?.address ?? null;
// Bun bundles the page on its first request. The server asks for it at startup, so the first kiosk
// load is warm, and /api/status says 503 until the page has built: a bundle that fails to build
// fails the updater's probe and rolls back, instead of passing it with a dead page.
let page: 'building' | 'ok' | 'failed' = 'building';
// Only the data that is here: a { dir } route throws at startup on a missing folder, and a Pi
// without a pack (or CI, where data/ is gitignored) must still answer /api/status.
const DATA = { '/tiles/imagery/*': IMAGERY_DIR, '/tiles/terrain/*': TERRAIN_DIR, '/tiles/lights/*': LIGHTS_DIR, '/buildings/*': BUILDINGS_DIR, '/roads/*': ROADS_DIR, '/models/*': MODELS_DIR, '/media/*': MEDIA_DIR };
const mounted = Object.entries(DATA).filter(([, dir]) => existsSync(dir));

/** A bearer check that takes the same time whatever the guess. */
function authorised(req: Request, token: string) {
	const [got, want] = [Buffer.from(req.headers.get('authorization') ?? ''), Buffer.from(`Bearer ${token}`)];
	return got.length === want.length && timingSafeEqual(got, want);
}

const num = (s: string | null) => (s !== null && s !== '' && Number.isFinite(Number(s)) ? Number(s) : null);
// Live sky weather (src/ops/live-weather.ts): Open-Meteo through this server, so every pane that
// polls the wall origin shares one cache. Offline-first: stale serves, nothing serves 503.
const weatherCache = new WeatherCache();

const PORT = Number(Bun.env.PORT ?? 3300);
const server = Bun.serve({
	port: PORT,
	maxRequestBodySize: MAX_MEDIA_BYTES + 65_536, // Bun's default is 128 MB; the checks below run after the body is read
	// No in-page hot swap: the page reloads whole every visit anyway, and a long-running --hot
	// server's HMR graph broke on a newly added import from outside the app (Oct 6).
	development: DEV ? { hmr: false } : false,
	routes: {
		'/': index,
		'/admin': admin,
		// The updater's health probe (deploy/aero-updater.sh) and health-check.sh read this.
		'/api/status': () =>
			Response.json(
				{ ok: page === 'ok', app: 'aero-3', page, fps, lastError, commit: COMMIT, uptimeSec: Math.round((Date.now() - startedAt) / 1000), wallVersion: wall.version, lan: lan(), port: PORT, data: mounted.map(([route]) => route.slice(1, -2)) },
				// The side panes read it from the centre Pi for the admin QR.
				{ status: page === 'ok' ? 200 : 503, headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } }
			),
		// { action: 'ok' | 'shed', tempC, ... } from health-check.sh; 'ok' when there is no file (a Mac, a fresh boot).
		'/api/thermal': async () => Response.json(await Bun.file(THERMAL_FILE).json().catch(() => ({ action: 'ok' })), { headers: { 'Cache-Control': 'no-store' } }),
		// The pane's one boot fetch (ops/live-weather.ts), same-origin or from the wall origin; CORS
		// open like /api/wall, because the side panes read it from the centre Pi's server.
		'/api/weather': async (req) => {
			const url = new URL(req.url);
			const lat = num(url.searchParams.get('lat'));
			const lon = num(url.searchParams.get('lon'));
			const cors = { 'Access-Control-Allow-Origin': '*' };
			if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180)
				return Response.json({ error: 'lat and lon query params required (-90..90, -180..180)' }, { status: 400, headers: { ...cors, 'Cache-Control': 'no-store' } });
			const out = await weatherCache.get(lat, lon);
			if (out === null) return Response.json({ error: 'weather provider unreachable' }, { status: 503, headers: { ...cors, 'Cache-Control': 'no-store' } });
			// A stale stand-in must not carry the 60 s shared-cache lifetime a live reading gets:
			// a proxy would be entitled to pin hour-old weather as current.
			const { fetchedAt: _, ...reading } = out;
			return Response.json(out.stale ? { ...reading, fromCache: true, stale: true } : { ...reading, fromCache: out.fromCache }, {
				headers: { ...cors, 'Cache-Control': out.stale ? 'no-store' : 'public, max-age=60' }
			});
		},
		'/api/wall': {
			// The other panes poll this from their own origin.
			GET: () => Response.json(wall, { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } }),
			async POST(req, srv) {
				// Dev with no token: this machine only. Production (the Pi service) stays fail-closed.
				const devOpen = !ADMIN_TOKEN && DEV && LOOPBACK.includes(srv.requestIP(req)?.address ?? '');
				if (!ADMIN_TOKEN && !devOpen) return new Response('wall push is off: set AERO_ADMIN_TOKEN', { status: 503 });
				if (!devOpen && !authorised(req, ADMIN_TOKEN)) return new Response('wrong token', { status: 401 });
				const text = await req.text();
				if (text.length > MAX_PUSH_BYTES) return new Response('too large', { status: 413 });
				let push;
				try {
					push = parsePush(JSON.parse(text));
				} catch {}
				if (!push) return new Response('expected { place, weather, clock, alt, scale, gains, media }: a known place, a known regime, an hour 0-24, alt 500-15000 m, scale 1-3, gains street/building/far 0-2 haze/glow/volume 0-1, media store IDs (8 audio, 1 video), or null', { status: 400 });
				wall = { ...push, version: wall.version + 1, applyAt: Math.ceil(Date.now() / 1000) + LEAD_SEC };
				const tmp = `${WALL_FILE}.${wall.version}.tmp`; // one per push: two overlapping pushes must not share it
				await Bun.write(tmp, JSON.stringify(wall));
				await rename(tmp, WALL_FILE); // whole or not at all, across a crash
				return Response.json(wall);
			}
		},
		// The operator's music and clips: open to list (a venue LAN discloses nothing
		// the panes are not already fetching), token-gated to fill, like aero-1's
		// /api/assets and aero-2's /api/media. Files serve from /media/* above.
		'/api/media': {
			GET: async () => {
				const names = await readdir(MEDIA_DIR).catch(() => [] as string[]);
				return Response.json({ media: names.filter((n) => mediaName(n)).sort() }, { headers: { 'Cache-Control': 'no-store' } });
			},
			async POST(req, srv) {
				const devOpen = !ADMIN_TOKEN && DEV && LOOPBACK.includes(srv.requestIP(req)?.address ?? '');
				if (!ADMIN_TOKEN && !devOpen) return new Response('media upload is off: set AERO_ADMIN_TOKEN', { status: 503 });
				if (!devOpen && !authorised(req, ADMIN_TOKEN)) return new Response('wrong token', { status: 401 });
				const declared = Number(req.headers.get('content-length') ?? 0);
				if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) return new Response(`too large: limit is ${MAX_MEDIA_BYTES} bytes`, { status: 413 });
				let form: FormData;
				try {
					form = await req.formData();
				} catch {
					return new Response('expected multipart/form-data', { status: 400 });
				}
				const file = form.get('file');
				if (!(file instanceof File)) return new Response('no `file` part in the upload', { status: 400 });
				if (file.size > MAX_MEDIA_BYTES) return new Response(`too large: limit is ${MAX_MEDIA_BYTES} bytes`, { status: 413 });
				const name = mediaName(file.name);
				if (!name) return new Response('expected an audio/video filename (mp3, wav, ogg, mp4, webm)', { status: 400 });
				await Bun.write(`${MEDIA_DIR}/${name}`, file);
				return Response.json({ media: name });
			}
		},
		// The kiosk on this machine reports its frame rate every 30 s; nobody else may.
		'/api/fps': {
			async POST(req, srv) {
				if (!LOOPBACK.includes(srv.requestIP(req)?.address ?? '')) return new Response('local only', { status: 403 });
				const n = Number(await req.text());
				fps = Number.isFinite(n) ? Math.max(0, Math.min(240, Math.round(n * 10) / 10)) : 0;
				return new Response(null, { status: 204 });
			}
		},
		// The kiosk's page reports its last thrown error (ops/kiosk.ts); one line, quotes stripped so
		// health-check.sh's grep scrape of /api/status stays whole.
		'/api/error': {
			async POST(req, srv) {
				if (!LOOPBACK.includes(srv.requestIP(req)?.address ?? '')) return new Response('local only', { status: 403 });
				// Stamped with the pane's wall time: the string lives until restart, so /admin can tell a fresh error from this morning's.
				const at = new Date().toTimeString().slice(0, 5);
				lastError = `${at} ${(await req.text()).replace(/["\\\n\r]/g, ' ')}`.slice(0, 200);
				return new Response(null, { status: 204 });
			}
		},
		'/api/fleet/heartbeat': {
			// Token-free to read: /admin on a LAN laptop polls it.
			GET: () => Response.json([...fleet.values()], { headers: { 'Cache-Control': 'no-store' } }),
			async POST(req, srv) {
				const devOpen = !FLEET_TOKEN && DEV && LOOPBACK.includes(srv.requestIP(req)?.address ?? '');
				if (!FLEET_TOKEN && !devOpen) return new Response('heartbeats are off: set AERO_FLEET_TOKEN', { status: 503 });
				if (!devOpen && !authorised(req, FLEET_TOKEN)) return new Response('wrong token', { status: 401 });
				const text = await req.text();
				if (text.length > MAX_HEARTBEAT_BYTES) return new Response('too large', { status: 413 });
				let beat;
				try {
					beat = parseHeartbeat(JSON.parse(text));
				} catch {}
				if (!beat) return new Response('expected a health-check.sh heartbeat', { status: 400 });
				if (!fleet.has(beat.deviceId) && fleet.size >= MAX_DEVICES) return new Response('too many devices', { status: 429 });
				fleet.set(beat.deviceId, { ...beat, receivedAt: Date.now() });
				return new Response(null, { status: 204 });
			}
		},
		...Object.fromEntries(mounted.map(([route, dir]) => [route, { dir }]))
	}
});

fetch(server.url)
	.then(async (r) => ((page = r.ok && (await r.text()).includes('<script') ? 'ok' : 'failed'), console.info(`aero-3 on ${server.url}, page ${page}`)))
	.catch((e) => ((page = 'failed'), console.error('page failed to build', e)));
