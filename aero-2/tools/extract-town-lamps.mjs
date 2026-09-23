#!/usr/bin/env node
/**
 * extract-town-lamps.mjs — distant towns as lamp points from the VIIRS raster.
 *
 * The night city has vectors (roads) and the globe has the VIIRS photograph,
 * but the towns BETWEEN them — the dozen lit clusters ringing every visit
 * inside a few hundred kilometres — were raster smudge only: glow with no
 * structure. From cruise the window reads them as haze, not habitation.
 *
 * So this bakes them offline: for each city, every z7 VIIRS tile in a ±2°
 * box is scanned in 4×4-pixel blocks (~5 km cells), and blocks brighter
 * than TOWN_THRESHOLD become lamp points with an intensity. The renderer
 * (`Towns.svelte`) draws them as soft amber circles over the raster —
 * clusters of individual lamps where the photograph has no pixels to give.
 *
 * Deterministic and idempotent: same pack, same bytes. Re-run after any
 * VIIRS refresh:
 *   node tools/extract-town-lamps.mjs
 *
 * City centres are duplicated from `Location.CATALOG` (that module is
 * TypeScript with rune-adjacent imports; this tool is plain node). If a
 * place moves, move it here too.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { lonLatToTile } from './stamp-road-glow.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const VIIRS_DIR = join(here, '../data/tiles/viirs');
const TOWNS_DIR = join(here, '../../data/towns');

/** z7: 1.2 km/px — one pixel per hamlet, one block per town. */
const SCAN_ZOOM = 7;
/** Half-width of the regional box around each centre, degrees. */
const BOX_DEG = 2;
/** Block size, pixels: 4×4 ≈ 5 km cells. */
const BLOCK = 4;
/** Blocks dimmer than this are dark ground, not towns. */
const TOWN_THRESHOLD = 0.25;

const CITIES = {
	hyderabad: [17.4435, 78.3772],
	mumbai: [19.076, 72.8777],
	dubai: [25.2048, 55.2708],
	dallas: [32.7767, -96.797],
	phoenix: [33.4352, -112.0101],
	las_vegas: [36.1699, -115.1398],
	denver: [39.8561, -104.6737],
	chicago_midway: [41.7868, -87.7522]
};

/** Longitude of a global pixel x at a zoom. */
export function pixelLon(px, z) {
	return (px / (256 * 2 ** z)) * 360 - 180;
}

/** Latitude of a global pixel y at a zoom (inverse slippy). */
export function pixelLat(py, z) {
	const n = Math.PI * (1 - (2 * py) / (256 * 2 ** z));
	return (Math.atan((Math.exp(n) - Math.exp(-n)) / 2) * 180) / Math.PI;
}

function tileAt(x, y) {
	const file = join(VIIRS_DIR, String(SCAN_ZOOM), String(y), `${x}.png`);
	return existsSync(file) ? PNG.sync.read(readFileSync(file)) : null;
}

function blockMax(png, bx, by) {
	let max = 0;
	for (let j = by * BLOCK; j < (by + 1) * BLOCK; j++) {
		if (j < 0 || j >= png.height) continue;
		for (let i = bx * BLOCK; i < (bx + 1) * BLOCK; i++) {
			if (i < 0 || i >= png.width) continue;
			const k = (j * png.width + i) * 4;
			if (png.data[k + 3] === 0) continue;
			const lum = (png.data[k] + png.data[k + 1] + png.data[k + 2]) / 3 / 255;
			if (lum > max) max = lum;
		}
	}
	return max;
}

/** Intensity 0..1 for a block max: hard threshold, soft top. */
export function townIntensity(lum) {
	if (!(lum > TOWN_THRESHOLD)) return 0;
	return Math.max(0, Math.min(1, (lum - TOWN_THRESHOLD) / (1 - TOWN_THRESHOLD)));
}

export function extractCity(id, lat, lon) {
	const [cx, cy] = lonLatToTile(lon, lat, SCAN_ZOOM);
	const features = [];
	// Tiles intersecting the box: ±BOX_DEG in tile units at this zoom.
	const span = Math.ceil((BOX_DEG / 360) * 2 ** SCAN_ZOOM) + 1;
	for (let ty = cy - span; ty <= cy + span; ty++) {
		for (let tx = cx - span; tx <= cx + span; tx++) {
			const png = tileAt(tx, ty);
			if (!png) continue;
			const cells = png.width / BLOCK;
			for (let by = 0; by < cells; by++) {
				for (let bx = 0; bx < cells; bx++) {
					const lum = blockMax(png, bx, by);
					// Round BEFORE the skip: a 0.004 intensity stored
					// as i:0 would draw nothing while claiming a lamp.
					const intensity = Math.round(townIntensity(lum) * 100) / 100;
					if (intensity <= 0) continue;
					// Block-centre global pixel → lon/lat.
					const gx = tx * png.width + bx * BLOCK + BLOCK / 2;
					const gy = ty * png.height + by * BLOCK + BLOCK / 2;
					const plon = pixelLon(gx, SCAN_ZOOM);
					const plat = pixelLat(gy, SCAN_ZOOM);
					if (Math.abs(plon - lon) > BOX_DEG || Math.abs(plat - lat) > BOX_DEG)
						continue;
					features.push({
						type: 'Feature',
						properties: { i: intensity },
						geometry: {
							type: 'Point',
							coordinates: [Math.round(plon * 1e5) / 1e5, Math.round(plat * 1e5) / 1e5]
						}
					});
				}
			}
		}
	}
	return { type: 'FeatureCollection', features };
}

export function extractAll() {
	mkdirSync(TOWNS_DIR, { recursive: true });
	for (const [id, [lat, lon]] of Object.entries(CITIES)) {
		const doc = extractCity(id, lat, lon);
		writeFileSync(join(TOWNS_DIR, `${id}.geojson`), JSON.stringify(doc));
		console.log(`${id}: ${doc.features.length} town lamps`);
	}
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) extractAll();
