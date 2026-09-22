#!/usr/bin/env node
/**
 * bake-viirs-lamps.mjs — city lights as lamp dots along the roads, not a sheet.
 *
 * VIIRS stops at z8, about 470 m a pixel, so below cruise MapLibre stretches
 * each pixel into a soft orange square and a city reads as one glowing
 * blanket. A passenger sees the opposite: strings of individual lamps along
 * every road, black between them, and the satellite's brightness only says
 * how bright each district's strings are.
 *
 * This bakes that, offline, for z9..z11 inside each city's road pack:
 *
 *   1. the z8 radiance is upsampled (bilinear) to the child tile;
 *   2. lamp dots are stamped along every road feature at a spacing that
 *      keeps them dots at that zoom, weighted by the road's stamped `glow`;
 *   3. radiance is multiplied by (FLOOR + (DOT_GAIN - FLOOR) * dots): black
 *      between lamps, the district's own brightness on them;
 *   4. written raw (white map, alpha 255) in the pack's WMTS layout, so the
 *      tile route tints it exactly like a z8 tile. Tiles with no roads pass
 *      the parent through untouched.
 *
 * Environment artists call this a detail texture; X-Plane and FlightGear
 * place their night lights from the road vectors at data-prep time the same
 * way. Nothing here runs on the Pi: a baked tile costs what a z8 tile costs.
 *
 * Deterministic and idempotent: same packs, same bytes. Existing tiles are
 * skipped unless --force. Re-run after any roads or VIIRS refresh:
 *   node tools/bake-viirs-lamps.mjs [city ...] [--force] [--zooms 9,10,11]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { lonLatToTile } from './stamp-road-glow.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROADS_DIR = join(here, '../../data/roads');
const VIIRS_DIR = process.env.TILE_DIR
	? join(process.env.TILE_DIR, 'viirs')
	: join(here, '../data/tiles/viirs');

const PARENT_ZOOM = 8;
const SIZE = 256;
/** Off-road radiance kept, so a lit district is not black between its lamps. */
const FLOOR = 0.1;
/** Lamp-head brightness relative to the district's satellite radiance. */
const DOT_GAIN = 1.6;
/** Metres between lamp heads by road class. Real spacing is 30-50 m; wider
 * for the small grid so it reads as scattered points, not a second line. */
const SPACING_M = { motorway: 45, trunk: 45, primary: 55, secondary: 75, tertiary: 95 };
const SPACING_DEFAULT_M = 120;
/** Minimum spacing in pixels: closer than this and dots merge into a line. */
const MIN_SPACING_PX = 4;
/** Dot radius in pixels at z11 by class; scales down with zoom, never below 0.7. */
const RADIUS_PX = { motorway: 1.4, trunk: 1.3, primary: 1.2, secondary: 1.1, tertiary: 1.0 };
const RADIUS_DEFAULT_PX = 0.9;

const args = process.argv.slice(2);
const force = args.includes('--force');
const zoomsArg = args.find((a) => a.startsWith('--zooms'));
const ZOOMS = zoomsArg ? zoomsArg.split('=')[1].split(',').map(Number) : [9, 10, 11];
const cityArgs = args.filter((a) => !a.startsWith('--'));

function metresPerPixel(z, lat) {
	return (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (SIZE * 2 ** z);
}

/** Tile-space pixel coords for a lon/lat at zoom z (fractional). */
function toTilePx(lon, lat, z) {
	const n = 2 ** z;
	const x = ((lon + 180) / 360) * n * SIZE;
	const latR = (lat * Math.PI) / 180;
	const y = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n * SIZE;
	return [x, y];
}

const parentCache = new Map();
function parentTile(x8, y8) {
	const key = `${x8}/${y8}`;
	if (parentCache.has(key)) return parentCache.get(key);
	const file = join(VIIRS_DIR, String(PARENT_ZOOM), String(y8), `${x8}.png`);
	const png = existsSync(file) ? PNG.sync.read(readFileSync(file)) : null;
	parentCache.set(key, png);
	return png;
}

/** Bilinear upsample of the parent sub-block covering child tile (z, x, y). */
function upsampledRadiance(z, x, y) {
	const shift = z - PARENT_ZOOM;
	const parent = parentTile(x >> shift, y >> shift);
	if (!parent) return null;
	const block = SIZE / 2 ** shift;
	const ox = (x % 2 ** shift) * block;
	const oy = (y % 2 ** shift) * block;
	const out = new Float32Array(SIZE * SIZE);
	const scale = block / SIZE;
	for (let py = 0; py < SIZE; py++) {
		const sy = oy + (py + 0.5) * scale - 0.5;
		const y0 = Math.max(0, Math.min(SIZE - 1, Math.floor(sy)));
		const y1 = Math.min(SIZE - 1, y0 + 1);
		const fy = Math.max(0, Math.min(1, sy - y0));
		for (let px = 0; px < SIZE; px++) {
			const sx = ox + (px + 0.5) * scale - 0.5;
			const x0 = Math.max(0, Math.min(SIZE - 1, Math.floor(sx)));
			const x1 = Math.min(SIZE - 1, x0 + 1);
			const fx = Math.max(0, Math.min(1, sx - x0));
			const at = (xx, yy) => parent.data[(yy * SIZE + xx) * 4];
			const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
			const bot = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
			out[py * SIZE + px] = top * (1 - fy) + bot * fy;
		}
	}
	return out;
}

/** Cheap deterministic hash in [0, 1) for lamp jitter. */
function hash01(a, b) {
	let h = (a * 374761393 + b * 668265263) | 0;
	h = (h ^ (h >>> 13)) * 1274126177;
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function stampDot(mask, cx, cy, r, w) {
	const x0 = Math.max(0, Math.floor(cx - r - 1));
	const x1 = Math.min(SIZE - 1, Math.ceil(cx + r + 1));
	const y0 = Math.max(0, Math.floor(cy - r - 1));
	const y1 = Math.min(SIZE - 1, Math.ceil(cy + r + 1));
	const inv = 1 / (2 * r * r);
	for (let yy = y0; yy <= y1; yy++) {
		for (let xx = x0; xx <= x1; xx++) {
			const dx = xx + 0.5 - cx;
			const dy = yy + 0.5 - cy;
			const v = w * Math.exp(-(dx * dx + dy * dy) * inv);
			const i = yy * SIZE + xx;
			if (v > mask[i]) mask[i] = v;
		}
	}
}

/** Lamp mask for one tile: dots along every road that crosses it. */
function lampMask(features, z, x, y, lat) {
	const mask = new Float32Array(SIZE * SIZE);
	const mpp = metresPerPixel(z, lat);
	const radiusScale = Math.max(0.7 / RADIUS_DEFAULT_PX, 2 ** (z - 11));
	const tx0 = x * SIZE;
	const ty0 = y * SIZE;
	const margin = 4;
	let any = false;
	features.forEach((f, fi) => {
		const b = f.bboxPx[z];
		if (b[2] < tx0 - margin || b[0] > tx0 + SIZE + margin) return;
		if (b[3] < ty0 - margin || b[1] > ty0 + SIZE + margin) return;
		const cls = f.properties.class;
		const spacing = Math.max(MIN_SPACING_PX, (SPACING_M[cls] ?? SPACING_DEFAULT_M) / mpp);
		const r = Math.max(0.7, (RADIUS_PX[cls] ?? RADIUS_DEFAULT_PX) * radiusScale);
		const w = Math.max(0.12, Math.min(1, f.properties.glow ?? 1));
		const pts = f.px[z];
		// Walk the polyline, dropping a lamp every `spacing` px with a little
		// jitter so parallel roads do not beat against each other.
		let carry = spacing * hash01(fi, z);
		for (let i = 1; i < pts.length; i++) {
			const [ax, ay] = pts[i - 1];
			const [bx, by] = pts[i];
			const len = Math.hypot(bx - ax, by - ay);
			if (len === 0) continue;
			let d = carry;
			while (d <= len) {
				const t = d / len;
				const cx = ax + (bx - ax) * t - tx0;
				const cy = ay + (by - ay) * t - ty0;
				if (cx > -margin && cx < SIZE + margin && cy > -margin && cy < SIZE + margin) {
					stampDot(mask, cx, cy, r, w);
					any = true;
				}
				d += spacing * (0.85 + 0.3 * hash01(fi, i * 7919 + Math.floor(d)));
			}
			carry = d - len;
		}
	});
	return any ? mask : null;
}

function bakeTile(features, z, x, y, lat, outFile) {
	const radiance = upsampledRadiance(z, x, y);
	if (!radiance) return 'no-parent';
	const mask = lampMask(features, z, x, y, lat);
	const png = new PNG({ width: SIZE, height: SIZE });
	let out = radiance;
	if (mask) {
		out = new Float32Array(SIZE * SIZE);
		// ponytail: no energy-preserving rescale. An 8-bit tile clips, so a gain that
		// keeps the sum lifts the floor instead; the z8→z9 crossfade dims a district
		// slightly as it sharpens, which is what a descent looks like anyway.
		for (let i = 0; i < out.length; i++) {
			out[i] = Math.min(255, radiance[i] * (FLOOR + (DOT_GAIN - FLOOR) * mask[i]));
		}
	}
	for (let i = 0; i < SIZE * SIZE; i++) {
		const v = Math.round(out[i]);
		png.data[i * 4] = v;
		png.data[i * 4 + 1] = v;
		png.data[i * 4 + 2] = v;
		png.data[i * 4 + 3] = 255;
	}
	mkdirSync(dirname(outFile), { recursive: true });
	writeFileSync(outFile, PNG.sync.write(png));
	return mask ? 'lamps' : 'passthrough';
}

function loadCity(file) {
	const geo = JSON.parse(readFileSync(file, 'utf8'));
	let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
	const features = [];
	for (const f of geo.features) {
		if (f.geometry?.type !== 'LineString') continue;
		const coords = f.geometry.coordinates;
		for (const [lon, lat] of coords) {
			if (lon < minLon) minLon = lon;
			if (lon > maxLon) maxLon = lon;
			if (lat < minLat) minLat = lat;
			if (lat > maxLat) maxLat = lat;
		}
		const px = {};
		const bboxPx = {};
		for (const z of ZOOMS) {
			const pts = coords.map(([lon, lat]) => toTilePx(lon, lat, z));
			px[z] = pts;
			bboxPx[z] = [
				Math.min(...pts.map((p) => p[0])),
				Math.min(...pts.map((p) => p[1])),
				Math.max(...pts.map((p) => p[0])),
				Math.max(...pts.map((p) => p[1]))
			];
		}
		features.push({ properties: f.properties ?? {}, px, bboxPx });
	}
	return { features, bbox: [minLon, minLat, maxLon, maxLat] };
}

function bakeCity(name) {
	const file = join(ROADS_DIR, `${name}.geojson`);
	if (!existsSync(file)) {
		console.error(`  ${name}: no roads pack at ${file}, skipped`);
		return;
	}
	const t0 = Date.now();
	const { features, bbox } = loadCity(file);
	const midLat = (bbox[1] + bbox[3]) / 2;
	const counts = { lamps: 0, passthrough: 0, 'no-parent': 0, skipped: 0 };
	for (const z of ZOOMS) {
		const [x0, y1] = lonLatToTile(bbox[0], bbox[1], z);
		const [x1, y0] = lonLatToTile(bbox[2], bbox[3], z);
		for (let x = x0; x <= x1; x++) {
			for (let y = y0; y <= y1; y++) {
				const outFile = join(VIIRS_DIR, String(z), String(y), `${x}.png`);
				if (!force && existsSync(outFile)) {
					counts.skipped++;
					continue;
				}
				counts[bakeTile(features, z, x, y, midLat, outFile)]++;
			}
		}
	}
	console.log(
		`  ${name}: ${features.length} roads → lamps ${counts.lamps}, passthrough ${counts.passthrough}, no z8 parent ${counts['no-parent']}, skipped ${counts.skipped} (${((Date.now() - t0) / 1000).toFixed(1)}s)`
	);
}

const cities = cityArgs.length
	? cityArgs
	: readdirSync(ROADS_DIR).filter((f) => f.endsWith('.geojson')).map((f) => f.replace(/\.geojson$/, ''));
console.log(`bake-viirs-lamps: zooms ${ZOOMS.join(',')} → ${VIIRS_DIR}`);
for (const c of cities) bakeCity(c);
