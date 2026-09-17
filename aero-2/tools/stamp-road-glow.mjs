#!/usr/bin/env node
/**
 * stamp-road-glow.mjs — per-road night intensity from the VIIRS raster itself.
 *
 * The vector night lights used to burn at one flat gain per city
 * (`nightGlow`): every road in Denver equally bright, whether it runs
 * through the downtown core or twenty kilometres of dark prairie. The
 * satellite disagrees — VIIRS shows cores orders of magnitude brighter
 * than their rims — so the vectors fought the raster underneath them
 * instead of sharpening it.
 *
 * The fix is baked offline, the same shape as `stamp-building-glow.mjs`:
 * each road feature gets a `glow` property sampled from the local VIIRS z8
 * pack at up to five points along its length, so lamp-runs through bright
 * ground burn at full weight and rural connectors dim toward ember. The
 * renderer (`Roads.svelte`) multiplies its opacities by it, falling back to
 * 1 for unstamped packs — fail open to the old flat look, never dark.
 *
 * Deterministic and idempotent: same pack, same bytes. Re-run after any
 * roads or VIIRS refresh:
 *   node tools/stamp-road-glow.mjs
 *
 * Normalisation (shared with nothing — the raster tint keeps its own):
 * per-city 5th–95th percentile mapped through
 *   glow = 0.12 + 0.88 * m^0.6, clamped to [0, 1].
 * The 0.12 floor keeps country roads alive rather than deleting them —
 * a real window still shows stray farm lamps — while the 0.6 curve spreads
 * the city's own middle instead of bunching it. Per-city, not global: a
 * global curve proved satellite-honest and visually flat on uniformly lit
 * cities (Hyderabad's median road read 1.0 — the whole stamp a no-op).
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const here = dirname(fileURLToPath(import.meta.url));
// Packs live at the repo root (shared data/, symlinked into the apps).
const ROADS_DIR = join(here, '../../data/roads');
const VIIRS_DIR = join(here, '../data/tiles/viirs');

/** z8: the finest VIIRS the GIBS product ships, 468 m/px at latitude 40. */
const SAMPLE_ZOOM = 8;
const SAMPLE_POINTS = 5;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Slippy tile for a lon/lat at a zoom. */
export function lonLatToTile(lon, lat, z) {
	const n = 2 ** z;
	const x = Math.floor(((lon + 180) / 360) * n);
	const latRad = (lat * Math.PI) / 180;
	const y = Math.floor(
		((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
	);
	return [x, y];
}

/**
 * Gain for a sampled VIIRS luminance against its city's own spread.
 *
 * GLOBAL normalisation (one curve for all cities) proved satellite-honest
 * and visually flat where it matters: Hyderabad's median road reads 1.0,
 * so the whole stamp is a no-op on the fielded kiosk's home wall. The
 * rotation should flatter each city, not compare them — a dim town and a
 * bright core both deserve texture — so each pack maps its own 5th–95th
 * percentile to the range and clamps outside it. Rural stays lit (the
 * 0.12 floor), cores saturate, and the middle spreads instead of bunching.
 *
 * Pure — unit-tested via road-glow.test.ts.
 */
export function glowFromLuminance(lum, p5, p95) {
	const span = p95 - p5;
	if (!(span > 1e-6)) return 1;
	const m = clamp01((lum - p5) / span);
	return clamp01(0.12 + 0.88 * Math.pow(m, 0.6));
}

/** Percentile of a sorted array, linear interpolation between ranks. */
export function percentile(sorted, q) {
	if (sorted.length === 0) return 0;
	const rank = q * (sorted.length - 1);
	const lo = Math.floor(rank);
	const hi = Math.ceil(rank);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

const tileCache = new Map();

/** Decoded z8 tile, or null when the pack does not cover the point. */
function tileAt(x, y) {
	const key = `${x}/${y}`;
	if (tileCache.has(key)) return tileCache.get(key);
	// WMTS layout on disk: z/y/x.
	const file = join(VIIRS_DIR, String(SAMPLE_ZOOM), String(y), `${x}.png`);
	const decoded = existsSync(file) ? PNG.sync.read(readFileSync(file)) : null;
	tileCache.set(key, decoded);
	return decoded;
}

/** Mean luminance of a 3x3 pixel block — tames single-pixel sensor noise. */
function blockLuminance(png, px, py) {
	let sum = 0;
	let n = 0;
	for (let j = py - 1; j <= py + 1; j++) {
		if (j < 0 || j >= png.height) continue;
		for (let i = px - 1; i <= px + 1; i++) {
			if (i < 0 || i >= png.width) continue;
			const k = (j * png.width + i) * 4;
			if (png.data[k + 3] === 0) continue;
			sum += (png.data[k] + png.data[k + 1] + png.data[k + 2]) / 3 / 255;
			n++;
		}
	}
	return n === 0 ? 0 : sum / n;
}

function luminanceAt(lon, lat) {
	const [x, y] = lonLatToTile(lon, lat, SAMPLE_ZOOM);
	const png = tileAt(x, y);
	if (!png) return null;
	const n = 2 ** SAMPLE_ZOOM;
	const latRad = (lat * Math.PI) / 180;
	const px = Math.floor((((lon + 180) / 360) * n - x) * png.width);
	const py = Math.floor(
		(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n - y) *
			png.height
	);
	return blockLuminance(png, px, py);
}

/**
 * Sample points at even ARC-LENGTH intervals along a LineString.
 *
 * Evenly-spaced VERTICES undersample long sparse segments: a 10 km rural
 * connector drawn as two vertices would read a single midpoint, while a
 * 200 m downtown alley with twenty vertices got five reads. Length is
 * what the glow averages over, so the samples walk the length.
 * Equirectangular metres (cos-latitude corrected) — good to ~1% at these
 * scales, and the samples only index a 468 m/px raster.
 */
export function sampleCoords(coords) {
	if (coords.length <= SAMPLE_POINTS) return coords;
	const lat0 = coords[0][1];
	const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
	const ky = 111_320;
	const seg = [];
	let total = 0;
	for (let i = 1; i < coords.length; i++) {
		const dx = (coords[i][0] - coords[i - 1][0]) * kx;
		const dy = (coords[i][1] - coords[i - 1][1]) * ky;
		const len = Math.hypot(dx, dy);
		seg.push(len);
		total += len;
	}
	if (!(total > 0)) return [coords[0]];
	const out = [];
	let si = 0;
	let acc = 0;
	for (let i = 0; i < SAMPLE_POINTS; i++) {
		const target = (i * total) / (SAMPLE_POINTS - 1);
		while (si < seg.length - 1 && acc + seg[si] < target) {
			acc += seg[si];
			si++;
		}
		const t = seg[si] > 0 ? (target - acc) / seg[si] : 0;
		const a = coords[si];
		const b = coords[si + 1];
		out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
	}
	return out;
}

/** Mean VIIRS luminance along a feature, or null when nothing is covered. */
export function featureLuminance(feature) {
	const geom = feature?.geometry;
	if (!geom) return null;
	// Roads packs hold LineStrings and MultiLineStrings only; anything
	// else (points, polygons) has no length to sample, so it reads null
	// rather than destructuring a coordinate pair into NaNs.
	const lines =
		geom.type === 'LineString'
			? [geom.coordinates]
			: geom.type === 'MultiLineString'
				? (geom.coordinates ?? [])
				: [];
	let sum = 0;
	let n = 0;
	for (const line of lines) {
		for (const [lon, lat] of sampleCoords(line)) {
			const lum = luminanceAt(lon, lat);
			if (lum !== null) {
				sum += lum;
				n++;
			}
		}
	}
	return n === 0 ? null : sum / n;
}

function stampFile(file) {
	const doc = JSON.parse(readFileSync(join(ROADS_DIR, file), 'utf8'));
	// Two passes: sample every feature first so the normalisation reads
	// THIS city's own spread (see glowFromLuminance), then assign.
	const lums = new Map();
	const samples = [];
	for (const feature of doc.features ?? []) {
		const lum = featureLuminance(feature);
		if (lum === null) continue;
		lums.set(feature, lum);
		samples.push(lum);
	}
	samples.sort((a, b) => a - b);
	const p5 = percentile(samples, 0.05);
	const p95 = percentile(samples, 0.95);
	let stamped = 0;
	for (const [feature, lum] of lums) {
		feature.properties = feature.properties ?? {};
		feature.properties.glow = Math.round(glowFromLuminance(lum, p5, p95) * 100) / 100;
		stamped++;
	}
	const uncovered = (doc.features ?? []).length - stamped;
	writeFileSync(join(ROADS_DIR, file), JSON.stringify(doc));
	console.log(
		`${file}: p5=${p5.toFixed(3)} p95=${p95.toFixed(3)} glow on ${stamped}, ${uncovered} past the pack edge`
	);
	return { stamped, uncovered };
}

export function stampAll() {
	const cities = readdirSync(ROADS_DIR).filter((f) => f.endsWith('.geojson'));
	for (const file of cities) stampFile(file);
}

// Guarded like stamp-building-glow: importing the pure functions for
// tests must not re-stamp the packs as a side effect.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) stampAll();
