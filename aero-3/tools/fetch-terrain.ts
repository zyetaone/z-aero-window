/**
 * Fill the terrain pack: every place's near (z10) and far (z8) terrarium tiles, from the
 * AWS Open Data `elevation-tiles-prod` bucket (Mapzen, public domain; no key). Skips what is
 * already on disk, so re-running is cheap. Without a place's far tiles its far ring is flat at
 * 0 m and has no sea floor, which the far ring's sea repaint (ground/maps.ts paintSea) reads.
 *
 *   bun tools/fetch-terrain.ts            # every place
 *   bun tools/fetch-terrain.ts dubai      # one
 *
 * Stored {z}/{y}/{x}.png like the rest of the pack; TERRAIN_DIR as in server.ts.
 */
import { PLACES } from '../src/flight/places.ts';
import { gridsFor } from '../src/world/ground/mercator.ts';

const DIR = Bun.env.TERRAIN_DIR ?? '../aero-2/data/tiles/terrarium';
const SOURCE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

const wanted = process.argv.slice(2);
for (const [place, [lat, lon]] of Object.entries(PLACES)) {
	if (wanted.length && !wanted.includes(place)) continue;
	let [fetched, kept] = [0, 0];
	for (const g of Object.values(gridsFor(lat, lon))) {
		for (let y = g.y0; y < g.y0 + g.span; y++) {
			for (let x = g.x0; x < g.x0 + g.span; x++) {
				const file = Bun.file(`${DIR}/${g.z}/${y}/${x}.png`);
				if (await file.exists()) {
					kept++;
					continue;
				}
				const res = await fetch(`${SOURCE}/${g.z}/${x}/${y}.png`);
				if (!res.ok) throw new Error(`${place} z${g.z} ${x},${y}: HTTP ${res.status}`);
				await Bun.write(file, res); // creates the folders
				fetched++;
			}
		}
	}
	console.info(`${place}: ${fetched} fetched, ${kept} already here`);
}
