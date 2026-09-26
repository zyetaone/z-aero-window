#!/usr/bin/env node
/**
 * stamp-building-glow.mjs — per-building night colours from the city glow.
 *
 * The night layer cannot sample the VIIRS raster (a fill has no per-pixel
 * input), and the local VIIRS pack is z3-8 — one pixel per city, useless per
 * building. So the "VIIRS mask" is baked offline: buildings glow where the
 * city glows. The pack centroid stands in for the lit core (downtown is the
 * densest kilometre), and each feature's `night` hex is its height-ramp
 * colour dimmed toward ember by distance from the core. Lit downtown towers
 * read window-warm; rural-edge sheds stay dark instead of glowing like the
 * city they are not in.
 *
 * Deterministic and idempotent: same pack, same bytes. Re-run after any
 * pack refresh:
 *   node tools/stamp-building-glow.mjs
 *
 * Height ramp (shared with Buildings.svelte's fallback):
 *   0m #7c2d12 → 30m #ffc98a → 120m #ffe3b8 → 300m #fff3df
 * Dimming: lerp(ramp, #2a1208, (1 - glow) * 0.8), glow 1 at core, 0 at rim.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Packs live at the repo root (shared data/, symlinked into the apps).
const BUILDINGS_DIR = join(here, '../../data/buildings');

const RAMP = [
	[0, [0x7c, 0x2d, 0x12]],
	[30, [0xff, 0xc9, 0x8a]],
	[120, [0xff, 0xe3, 0xb8]],
	[300, [0xff, 0xf3, 0xdf]]
];
const EMBER = [0x2a, 0x12, 0x08];
const DEFAULT_HEIGHT = 20;

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => a + (b - a) * t;

export function heightRampRgb(h) {
	const height = Math.max(0, h);
	if (height <= RAMP[0][0]) return [...RAMP[0][1]];
	for (let i = 1; i < RAMP.length; i++) {
		if (height <= RAMP[i][0]) {
			const [h0, c0] = RAMP[i - 1];
			const [h1, c1] = RAMP[i];
			const t = (height - h0) / (h1 - h0);
			return [0, 1, 2].map((k) => Math.round(lerp(c0[k], c1[k], t)));
		}
	}
	return [...RAMP[RAMP.length - 1][1]];
}

export function glowColor(height, glow) {
	const lit = heightRampRgb(height);
	const dim = clamp01(1 - glow) * 0.8;
	const rgb = lit.map((c, k) => Math.round(lerp(c, EMBER[k], dim)));
	return '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
}

function centroidOf(ring) {
	let x = 0;
	let y = 0;
	for (const [lon, lat] of ring) {
		x += lon;
		y += lat;
	}
	return [x / ring.length, y / ring.length];
}

function featureCentroid(feature) {
	const geom = feature.geometry;
	if (!geom) return null;
	if (geom.type === 'Polygon') return centroidOf(geom.coordinates[0]);
	if (geom.type === 'MultiPolygon') return centroidOf(geom.coordinates[0][0]);
	return null;
}

const M_PER_DEG = 111320;

function stampPack(path) {
	const raw = JSON.parse(readFileSync(path, 'utf8'));
	const features = raw.features ?? [];
	const cents = [];
	for (const f of features) {
		const c = featureCentroid(f);
		if (c) cents.push(c);
	}
	if (!cents.length) return { file: path, stamped: 0 };
	const cx = cents.reduce((a, c) => a + c[0], 0) / cents.length;
	const cy = cents.reduce((a, c) => a + c[1], 0) / cents.length;
	const cosLat = Math.cos((cy * Math.PI) / 180);
	const dist = (c) => Math.hypot((c[0] - cx) * M_PER_DEG * cosLat, (c[1] - cy) * M_PER_DEG);
	const maxDist = Math.max(1, ...cents.map(dist));
	let stamped = 0;
	features.forEach((f, i) => {
		const c = cents[i];
		if (!c) return;
		const glow = clamp01(1 - dist(c) / maxDist);
		const height = Number(f.properties?.height) || DEFAULT_HEIGHT;
		f.properties = { ...f.properties, night: glowColor(height, glow) };
		stamped++;
	});
	// Packs are Python-json formatted (', ' / ': ' separators, single line):
	// match it so a re-stamp only adds the `night` properties. Safe only
	// because pack string values (hex colours) hold no ':' or ','.
	const text = JSON.stringify(raw).replaceAll(':', ': ').replaceAll(',', ', ');
	writeFileSync(path, text);
	return { file: path, stamped };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
	const { readdirSync } = await import('node:fs');
	for (const name of readdirSync(BUILDINGS_DIR).filter((n) => n.endsWith('.geojson'))) {
		const r = stampPack(join(BUILDINGS_DIR, name));
		console.log(`stamp-building-glow: ${name}: ${r.stamped} features`);
	}
}
