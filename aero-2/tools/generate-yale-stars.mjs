#!/usr/bin/env node
/**
 * generate-yale-stars.mjs — Yale Bright Star Catalog → vendored star module.
 *
 * CHECKPOINT 2 of the night sky: real catalogue positions (J2000 RA/Dec),
 * real visual magnitudes, and real B-V colour indices replace the seeded
 * Fibonacci-sphere placeholders. 8,404 stars at Vmag ≤ 6.5 — the catalogue's
 * own stated naked-eye limit.
 *
 * SOURCE (fetch once, keep the download out of the repo):
 *   https://raw.githubusercontent.com/frostoven/BSC5P-JSON/primary/bsc5p_min.json
 * which is Hoffleit & Warren's BSC5P (5th Revised Ed., preliminary) converted
 * to JSON, via HEASARC. Catalogue data is factual; vendored here with
 * attribution in the emitted header, per HEASARC terms.
 *
 * QUANTIZATION (positions to ~20 arcsec — a rendered pixel is arcminutes):
 *   ra   uint16  raDeg / 360
 *   dec  uint16  (decDeg + 90) / 180
 *   vmag uint8   (vmag + 2) * 20          → -2.00 .. 10.75
 *   bv   uint8   (bv + 0.5) * 60, clamped → -0.50 .. 2.50 (missing → +0.60)
 * 7 bytes/star, padded to 8, base64. ~66 KB for the whole sky.
 *
 * Run: node tools/generate-yale-stars.mjs /tmp/bsc5p_min.json
 * Emits: src/lib/display/world/yale-stars.ts (overwrites wholesale).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAG_LIMIT = 6.5;
const BV_DEFAULT = 0.6;

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../src/lib/display/world/yale-stars.ts');

function fail(message) {
	console.error(`generate-yale-stars: ${message}`);
	process.exit(1);
}

const srcPath = process.argv[2];
if (!srcPath) fail('usage: node tools/generate-yale-stars.mjs <bsc5p_min.json>');

let entries;
try {
	entries = JSON.parse(readFileSync(srcPath, 'utf8'));
} catch (err) {
	fail(`cannot read ${srcPath}: ${err.message}`);
}
if (!Array.isArray(entries)) fail('expected a top-level JSON array');

const q16 = (v) => Math.max(0, Math.min(65535, Math.round(v * 65535)));
const q8 = (v) => Math.max(0, Math.min(255, Math.round(v)));

const bytes = [];
let skipped = 0;
for (const s of entries) {
	const vmagRaw = s.visualMagnitude;
	if (vmagRaw === null || vmagRaw === undefined || vmagRaw === '') {
		skipped++;
		continue;
	}
	const vmag = Number(vmagRaw);
	if (!Number.isFinite(vmag) || vmag > MAG_LIMIT) {
		skipped++;
		continue;
	}
	const raH = Number(s.hoursRaJ2000);
	const raM = Number(s.minutesRaJ2000);
	const raS = Number(s.secondsRaJ2000);
	const decD = Number(s.degreesDecJ2000);
	const decM = Number(s.minutesDecJ2000);
	const decS = Number(s.secondsDecJ2000);
	if (![raH, raM, raS, decD, decM, decS].every(Number.isFinite)) {
		skipped++;
		continue;
	}
	const ra = ((raH + raM / 60 + raS / 3600) * 15) % 360;
	const dec = (s.signDecJ2000 === '-' ? -1 : 1) * (decD + decM / 60 + decS / 3600);
	let bv = BV_DEFAULT;
	if (s.bvColorUbv !== null && s.bvColorUbv !== undefined && s.bvColorUbv !== '') {
		const parsed = Number(s.bvColorUbv);
		if (Number.isFinite(parsed)) bv = parsed;
	}

	const raQ = q16(ra / 360);
	const decQ = q16((dec + 90) / 180);
	const magQ = q8((vmag + 2) * 20);
	const bvQ = q8((Math.max(-0.5, Math.min(2.5, bv)) + 0.5) * 60);
	bytes.push((raQ >> 8) & 0xff, raQ & 0xff, (decQ >> 8) & 0xff, decQ & 0xff, magQ, bvQ, 0, 0);
}

const count = bytes.length / 8;
const b64 = Buffer.from(bytes).toString('base64');

const header = `/**
 * yale-stars — the Yale Bright Star Catalog, vendored for the night sky.
 *
 * GENERATED — do not hand-edit. Regenerate with:
 *   node tools/generate-yale-stars.mjs /tmp/bsc5p_min.json
 * Source: BSC5P (Hoffleit & Warren, 5th Rev. Ed. preliminary) via HEASARC,
 * JSON conversion by frostoven/BSC5P-JSON. ${count} stars at Vmag <= ${MAG_LIMIT.toFixed(1)}
 * (entries fainter than the limit or missing coordinates: ${skipped} skipped).
 *
 * Positions are J2000.0 RA/Dec. Precession to the current epoch (~1.4 deg
 * over the catalogue's lifetime) is deliberately NOT applied: at this
 * stylization a pixel is arcminutes wide and no constellation is
 * recognisably displaced. If arcminute truth ever matters, precess here.
 *
 * Layout: 8 bytes/star, big-endian —
 *   u16 raDeg/360, u16 (decDeg+90)/180, u8 (vmag+2)*20, u8 (bv+0.5)*60,
 *   2 pad bytes. Missing B-V decodes as +0.60 (ordinary dwarf).
 */
`;

const body = `export const YALE_STAR_COUNT = ${count};

export interface YaleCatalog {
	/** Right ascension, degrees 0..360 (J2000). */
	ra: Float32Array;
	/** Declination, degrees -90..90 (J2000). */
	dec: Float32Array;
	/** Visual magnitude, roughly -1.5..6.5. */
	vmag: Float32Array;
	/** B-V colour index, roughly -0.5..2.5. */
	bv: Float32Array;
}

const B64 =
	'${b64}';

let cached: YaleCatalog | null = null;

/**
 * Decode the vendored sky. Same bytes on every pane, so the wall agrees
 * star for star without exchanging anything. Result is cached: the sky
 * never changes under the session.
 */
export function yaleCatalog(): YaleCatalog {
	if (cached) return cached;
	const bin = atob(B64);
	const raw = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
	const ra = new Float32Array(YALE_STAR_COUNT);
	const dec = new Float32Array(YALE_STAR_COUNT);
	const vmag = new Float32Array(YALE_STAR_COUNT);
	const bv = new Float32Array(YALE_STAR_COUNT);
	for (let i = 0; i < YALE_STAR_COUNT; i++) {
		const o = i * 8;
		ra[i] = ((raw[o] << 8) | raw[o + 1]) / 65535;
		ra[i] *= 360;
		dec[i] = (((raw[o + 2] << 8) | raw[o + 3]) / 65535) * 180 - 90;
		vmag[i] = raw[o + 4] / 20 - 2;
		bv[i] = raw[o + 5] / 60 - 0.5;
	}
	cached = { ra, dec, vmag, bv };
	return cached;
}
`;

writeFileSync(outPath, header + body);
console.log(`generate-yale-stars: ${count} stars → ${outPath}`);
