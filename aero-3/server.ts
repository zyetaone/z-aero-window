/**
 * aero-3's whole server: the page, and the tiles off local disk.
 *
 * Bun bundles `index.html` and everything it imports (no Vite, no SvelteKit),
 * and the `{ dir }` routes serve the tile trees with content types and range
 * handling built in. They refuse `..`, so no path guard is needed here. Both
 * trees are the ones aero-1 and aero-2 already ship, stored `{z}/{y}/{x}`.
 *
 * Defaults resolve from the working directory, not `import.meta.dir`: inside a
 * `--compile`d binary that is the embedded filesystem, where no tiles live.
 */
import index from './index.html';

const IMAGERY_DIR = Bun.env.IMAGERY_DIR ?? '../data/tiles/sentinel2';
const TERRAIN_DIR = Bun.env.TERRAIN_DIR ?? '../aero-2/data/tiles/terrarium';
const LIGHTS_DIR = Bun.env.LIGHTS_DIR ?? '../aero-2/data/tiles/viirs';
// Written by `python3 ../aero-2/tools/fetch-buildings.py <place> --radius 3500 --max-features 20000 --out .`
const BUILDINGS_DIR = Bun.env.BUILDINGS_DIR ?? './data/buildings';

const server = Bun.serve({
	port: Number(Bun.env.PORT ?? 3300),
	development: Bun.env.NODE_ENV !== 'production',
	routes: {
		'/': index,
		'/tiles/imagery/*': { dir: IMAGERY_DIR },
		'/tiles/terrain/*': { dir: TERRAIN_DIR },
		'/tiles/lights/*': { dir: LIGHTS_DIR },
		'/buildings/*': { dir: BUILDINGS_DIR }
	}
});

console.info(`aero-3 on ${server.url}`);
