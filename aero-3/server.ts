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
import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import index from './index.html';
import admin from './admin.html';
import { LEAD_SEC, MAX_PUSH_BYTES, NO_WALL, parsePush, type Wall } from './src/ops/wall.ts';
import { MAX_DEVICES, MAX_HEARTBEAT_BYTES, parseHeartbeat, type FleetRow } from './src/ops/fleet.ts';

const IMAGERY_DIR = Bun.env.IMAGERY_DIR ?? '../data/tiles/sentinel2';
const TERRAIN_DIR = Bun.env.TERRAIN_DIR ?? '../aero-2/data/tiles/terrarium';
const LIGHTS_DIR = Bun.env.LIGHTS_DIR ?? '../aero-2/data/tiles/viirs';
// Written by `python3 ../aero-2/tools/fetch-buildings.py <place> --radius 3500 --max-features 20000 --out .`
const BUILDINGS_DIR = Bun.env.BUILDINGS_DIR ?? './data/buildings';
// The road packs aero-1 and aero-2 already ship (aero-1/tools/tile-packager/src/roads.ts), stamped with class.
const ROADS_DIR = Bun.env.ROADS_DIR ?? '../data/roads';
// aero-2's 737 wing, ~1 MB: CC-BY-4.0, by "A Random Modeler" on Sketchfab (credited in src/wing.ts).
const MODELS_DIR = Bun.env.MODELS_DIR ?? '../aero-2/static/models';
// The wall (src/ops/wall.ts): what the operator last pushed, kept across restarts.
const WALL_FILE = Bun.env.WALL_FILE ?? './data/wall.json';
// Fails closed: with no token set, nothing can push.
const ADMIN_TOKEN = Bun.env.AERO_ADMIN_TOKEN ?? '';
// Each Pi's health-check.sh heartbeat to the wall Pi: a lower-privilege token than the admin one.
const FLEET_TOKEN = Bun.env.AERO_FLEET_TOKEN ?? '';
const fleet = new Map<string, FleetRow>();
// What this pane's page last measured (POST /api/fps from the kiosk on this machine).
let fps = 0;
// The checkout the updater put here; health-check.sh reports it.
const COMMIT = Bun.env.AERO_COMMIT ?? Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { stderr: 'ignore' }).stdout.toString().trim();
const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
// A compiled binary runs from Bun's embedded filesystem: never dev mode on a Pi, NODE_ENV or not.
const DEV = Bun.env.NODE_ENV !== 'production' && !import.meta.path.startsWith('/$bunfs');
let wall: Wall = await Bun.file(WALL_FILE).json().catch(() => NO_WALL);
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
const DATA = { '/tiles/imagery/*': IMAGERY_DIR, '/tiles/terrain/*': TERRAIN_DIR, '/tiles/lights/*': LIGHTS_DIR, '/buildings/*': BUILDINGS_DIR, '/roads/*': ROADS_DIR, '/models/*': MODELS_DIR };
const mounted = Object.entries(DATA).filter(([, dir]) => existsSync(dir));

/** A bearer check that takes the same time whatever the guess. */
function authorised(req: Request, token: string) {
	const [got, want] = [Buffer.from(req.headers.get('authorization') ?? ''), Buffer.from(`Bearer ${token}`)];
	return got.length === want.length && timingSafeEqual(got, want);
}

const PORT = Number(Bun.env.PORT ?? 3300);
const server = Bun.serve({
	port: PORT,
	// No in-page hot swap: the page reloads whole every visit anyway, and a long-running --hot
	// server's HMR graph broke on a newly added import from outside the app (Oct 6).
	development: DEV ? { hmr: false } : false,
	routes: {
		'/': index,
		'/admin': admin,
		// The updater's health probe (deploy/aero-updater.sh) and health-check.sh read this.
		'/api/status': () =>
			Response.json(
				{ ok: page === 'ok', app: 'aero-3', page, fps, commit: COMMIT, uptimeSec: Math.round((Date.now() - startedAt) / 1000), wallVersion: wall.version, lan: lan(), port: PORT, data: mounted.map(([route]) => route.slice(1, -2)) },
				// The side panes read it from the centre Pi for the admin QR.
				{ status: page === 'ok' ? 200 : 503, headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } }
			),
		// { action: 'ok' | 'shed', tempC, ... } from health-check.sh; 'ok' when there is no file (a Mac, a fresh boot).
		'/api/thermal': async () => Response.json(await Bun.file(THERMAL_FILE).json().catch(() => ({ action: 'ok' })), { headers: { 'Cache-Control': 'no-store' } }),
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
				if (!push) return new Response('expected { place, weather, clock }: a known place, a known regime, an hour 0-24, or null', { status: 400 });
				wall = { ...push, version: wall.version + 1, applyAt: Math.ceil(Date.now() / 1000) + LEAD_SEC };
				const tmp = `${WALL_FILE}.${wall.version}.tmp`; // one per push: two overlapping pushes must not share it
				await Bun.write(tmp, JSON.stringify(wall));
				await rename(tmp, WALL_FILE); // whole or not at all, across a crash
				return Response.json(wall);
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
