#!/usr/bin/env bun
/**
 * pack-pmtiles — a tile directory → one .pmtiles archive.
 *
 * Loose tiles are easy to inspect but bad to ship: an SD card holding hundreds
 * of thousands of tiny files pays filesystem overhead on every read. PMTiles is
 * one file, read by HTTP Range request — adapter-bun registers static assets as
 * native Bun routes and answers 206 with Accept-Ranges/Content-Range (verified
 * against a built server, not assumed from the docs).
 *
 * Goes via MBTiles because that is what `pmtiles convert` accepts, and MBTiles
 * is just a SQLite schema — bun ships SQLite, so this needs no mb-util.
 *
 * NOTE the y-axis flip: on disk (and in XYZ) y counts from the top; MBTiles
 * counts rows from the bottom. Get this wrong and the terrain is mirrored
 * north/south, which reads as "the DEM is broken" rather than "the row index
 * is upside down".
 *
 * Usage:
 *   bun tools/pack-pmtiles.ts <layer> [outPath]
 *   bun tools/pack-pmtiles.ts terrarium data/tiles/hyderabad-terrain.pmtiles
 */
import { Database } from 'bun:sqlite';
import { readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const [layer, outArg] = process.argv.slice(2);
if (!layer) {
	console.error('Usage: bun tools/pack-pmtiles.ts <layer> [outPath]');
	process.exit(1);
}

const TILE_DIR = process.env.TILE_DIR ?? 'data/tiles';
const SRC = resolve(TILE_DIR, layer);
const OUT = resolve(outArg ?? `${TILE_DIR}/${layer}.pmtiles`);
const MBTILES = `${OUT}.mbtiles`;

if (!existsSync(SRC)) {
	console.error(`No such tile dir: ${SRC}`);
	process.exit(1);
}

const ext = layer === 'terrarium' ? 'png' : 'jpg';
const format = ext;

const numeric = (dir: string) =>
	readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
		.map((e) => Number(e.name))
		.sort((a, b) => a - b);

for (const stale of [MBTILES, OUT]) if (existsSync(stale)) rmSync(stale);

const db = new Database(MBTILES, { create: true });
db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
db.exec('CREATE TABLE metadata (name text, value text);');
db.exec(
	'CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob);'
);

const insertTile = db.prepare(
	'INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)'
);

let count = 0;
let minZoom = Infinity;
let maxZoom = -Infinity;
let minX = Infinity;
let maxX = -Infinity;
let minY = Infinity;
let maxY = -Infinity;

const insertAll = db.transaction((rows: [number, number, number, Uint8Array][]) => {
	for (const r of rows) insertTile.run(...r);
});

for (const z of numeric(SRC)) {
	const rows: [number, number, number, Uint8Array][] = [];
	for (const y of numeric(`${SRC}/${z}`)) {
		for (const entry of readdirSync(`${SRC}/${z}/${y}`)) {
			const m = entry.match(/^(\d+)\.(.+)$/);
			if (!m || m[2] !== ext) continue;
			const x = Number(m[1]);
			const data = new Uint8Array(await Bun.file(`${SRC}/${z}/${y}/${entry}`).arrayBuffer());
			// XYZ/WMTS y counts from the top; MBTiles rows count from the bottom.
			rows.push([z, x, (1 << z) - 1 - y, data]);
			count++;
			if (z < minZoom) minZoom = z;
			if (z > maxZoom) maxZoom = z;
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	}
	insertAll(rows);
	console.log(`  z${z}: ${rows.length} tiles`);
}

if (count === 0) {
	console.error(`No .${ext} tiles found under ${SRC}`);
	process.exit(1);
}

// Bounds from the widest zoom's tile extent, in lon/lat.
const tileToLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileToLat = (y: number, z: number) => {
	const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
	return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};
const bounds = [
	tileToLon(minX, maxZoom),
	tileToLat(maxY + 1, maxZoom),
	tileToLon(maxX + 1, maxZoom),
	tileToLat(minY, maxZoom)
].join(',');

const meta = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
for (const [k, v] of [
	['name', layer],
	['format', format],
	['type', 'baselayer'],
	['version', '1'],
	['minzoom', String(minZoom)],
	['maxzoom', String(maxZoom)],
	['bounds', bounds],
	// Terrarium is elevation, not colour — a consumer that guesses from `format`
	// alone would treat it as an ordinary raster.
	[
		'description',
		layer === 'terrarium' ? 'Terrarium-encoded elevation (Mapzen / AWS Open Data)' : layer
	]
]) {
	meta.run(k, v);
}
db.exec('CREATE UNIQUE INDEX tile_index on tiles (zoom_level, tile_column, tile_row);');
db.close();

const conv = Bun.spawnSync(['pmtiles', 'convert', MBTILES, OUT], {
	stdout: 'inherit',
	stderr: 'inherit'
});
if (conv.exitCode !== 0) {
	console.error('pmtiles convert failed; intermediate kept at', MBTILES);
	process.exit(1);
}
rmSync(MBTILES);

console.log(
	`${OUT} — ${count} tiles, z${minZoom}-${maxZoom}, ${(statSync(OUT).size / 1e6).toFixed(1)} MB`
);
