/**
 * aero-3's whole server: the page, the tiles off local disk, and the wall an
 * operator pushes to every pane (`/admin`, src/wall.ts).
 *
 * Bun bundles `index.html` and everything it imports (no Vite, no SvelteKit),
 * and the `{ dir }` routes serve the tile trees with content types and range
 * handling built in. They refuse `..`, so no path guard is needed here. Both
 * trees are the ones aero-1 and aero-2 already ship, stored `{z}/{y}/{x}`.
 *
 * Defaults resolve from the working directory, not `import.meta.dir`: inside a
 * `--compile`d binary that is the embedded filesystem, where no tiles live.
 */
import { rename } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import index from './index.html';
import admin from './admin.html';
import { LEAD_SEC, MAX_PUSH_BYTES, NO_WALL, parsePush, type Wall } from './src/wall.ts';

const IMAGERY_DIR = Bun.env.IMAGERY_DIR ?? '../data/tiles/sentinel2';
const TERRAIN_DIR = Bun.env.TERRAIN_DIR ?? '../aero-2/data/tiles/terrarium';
const LIGHTS_DIR = Bun.env.LIGHTS_DIR ?? '../aero-2/data/tiles/viirs';
// Written by `python3 ../aero-2/tools/fetch-buildings.py <place> --radius 3500 --max-features 20000 --out .`
const BUILDINGS_DIR = Bun.env.BUILDINGS_DIR ?? './data/buildings';
// The road packs aero-1 and aero-2 already ship (aero-1/tools/tile-packager/src/roads.ts), stamped with class.
const ROADS_DIR = Bun.env.ROADS_DIR ?? '../data/roads';
// aero-2's 737 wing, ~1 MB: CC-BY-4.0, by "A Random Modeler" on Sketchfab (credited in src/wing.ts).
const MODELS_DIR = Bun.env.MODELS_DIR ?? '../aero-2/static/models';
// The wall (src/wall.ts): what the operator last pushed, kept across restarts.
const WALL_FILE = Bun.env.WALL_FILE ?? './data/wall.json';
// Fails closed: with no token set, nothing can push.
const ADMIN_TOKEN = Bun.env.AERO_ADMIN_TOKEN ?? '';
let wall: Wall = await Bun.file(WALL_FILE).json().catch(() => NO_WALL);

/** A bearer check that takes the same time whatever the guess. */
function authorised(req: Request) {
	const [got, want] = [Buffer.from(req.headers.get('authorization') ?? ''), Buffer.from(`Bearer ${ADMIN_TOKEN}`)];
	return got.length === want.length && timingSafeEqual(got, want);
}

const server = Bun.serve({
	port: Number(Bun.env.PORT ?? 3300),
	// A compiled binary runs from Bun's embedded filesystem: never dev mode on a Pi, NODE_ENV or not.
	development: Bun.env.NODE_ENV !== 'production' && !import.meta.path.startsWith('/$bunfs'),
	routes: {
		'/': index,
		'/admin': admin,
		'/api/wall': {
			// The other panes poll this from their own origin.
			GET: () => Response.json(wall, { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } }),
			async POST(req) {
				if (!ADMIN_TOKEN) return new Response('wall push is off: set AERO_ADMIN_TOKEN', { status: 503 });
				if (!authorised(req)) return new Response('wrong token', { status: 401 });
				const text = await req.text();
				if (text.length > MAX_PUSH_BYTES) return new Response('too large', { status: 413 });
				let push;
				try {
					push = parsePush(JSON.parse(text));
				} catch {}
				if (!push) return new Response('expected { place, weather, clock }: a known place, a known regime, an hour 0-24, or null', { status: 400 });
				wall = { ...push, version: wall.version + 1, applyAt: Math.ceil(Date.now() / 1000) + LEAD_SEC };
				await Bun.write(`${WALL_FILE}.tmp`, JSON.stringify(wall));
				await rename(`${WALL_FILE}.tmp`, WALL_FILE); // whole or not at all, across a power cut
				return Response.json(wall);
			}
		},
		'/tiles/imagery/*': { dir: IMAGERY_DIR },
		'/tiles/terrain/*': { dir: TERRAIN_DIR },
		'/tiles/lights/*': { dir: LIGHTS_DIR },
		'/buildings/*': { dir: BUILDINGS_DIR },
		'/roads/*': { dir: ROADS_DIR },
		'/models/*': { dir: MODELS_DIR }
	}
});

console.info(`aero-3 on ${server.url}`);
