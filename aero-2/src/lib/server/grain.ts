/**
 * Synthetic Perlin-ish grain tile — one deterministic PNG for every z/x/y.
 *
 * WHY: the VIIRS halo is a z8 (468 m/px) smudge. On approach it reads as flat
 * grey pixels — block edges, banding, no tooth. A grain layer over it breaks
 * the blocks into something the eye reads as atmosphere instead of pixels.
 * A static asset would work but then the pack has to carry it, the health
 * check has to know it, and a fielded Pi serves one more thing from disk.
 * Rendering 256×256 of seeded value noise costs microseconds once (cached in
 * module) and is byte-identical on every pane, every boot, forever.
 *
 * Tileable by construction: the lattice wraps, so the same tile repeats at
 * every pyramid address with no seams. Runtime-free pure math plus node:zlib
 * for the DEFLATE — no image dependency. Test seam: `grainPng()` twice must
 * be byte-equal, and the header must parse as 256×256 grey.
 */
import { deflateSync } from 'node:zlib';

export const GRAIN_SIZE = 256;
/** Lattice cells across the tile — features ~8 px, under the z8 block. */
const CELLS = 32;
/** Mean grey with ±amplitude tooth. */
const MEAN = 128;
const AMPLITUDE = 44;
/** Fixed seed: the wall must agree, and "random per boot" would shimmer. */
const SEED = 0x51ab3d;

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** One channel of tileable value noise, 0..255. Built once, shared. */
let lattice: Float32Array | null = null;

function getLattice(): Float32Array {
	if (!lattice) {
		const rng = mulberry32(SEED);
		lattice = new Float32Array(CELLS * CELLS);
		for (let i = 0; i < lattice.length; i++) lattice[i] = rng();
	}
	return lattice;
}

export function grainValue(x: number, y: number): number {
	const lat = getLattice();
	const gx = (x / GRAIN_SIZE) * CELLS;
	const gy = (y / GRAIN_SIZE) * CELLS;
	const x0 = Math.floor(gx) % CELLS;
	const y0 = Math.floor(gy) % CELLS;
	const x1 = (x0 + 1) % CELLS;
	const y1 = (y0 + 1) % CELLS;
	const fx = smooth(gx - Math.floor(gx));
	const fy = smooth(gy - Math.floor(gy));
	const a = lat[y0 * CELLS + x0];
	const b = lat[y0 * CELLS + x1];
	const c = lat[y1 * CELLS + x0];
	const d = lat[y1 * CELLS + x1];
	const v = a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
	return Math.max(0, Math.min(255, Math.round(MEAN + (v - 0.5) * 2 * AMPLITUDE)));
}

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, data.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(data, 8);
	const crc = crc32(out.subarray(4, 8 + data.length));
	dv.setUint32(8 + data.length, crc);
	return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((n, p) => n + p.length, 0);
	const out = new Uint8Array(total);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

let cached: Uint8Array | null = null;

/** The full PNG file bytes — grey, 256×256, deterministic. */
export function grainPng(): Uint8Array {
	if (cached) return cached;
	const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
	const ihdr = new Uint8Array(13);
	const dv = new DataView(ihdr.buffer);
	dv.setUint32(0, GRAIN_SIZE);
	dv.setUint32(4, GRAIN_SIZE);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 0; // grey
	const raw = new Uint8Array(GRAIN_SIZE * (GRAIN_SIZE + 1));
	for (let y = 0; y < GRAIN_SIZE; y++) {
		raw[y * (GRAIN_SIZE + 1)] = 0; // filter: none
		for (let x = 0; x < GRAIN_SIZE; x++) {
			raw[y * (GRAIN_SIZE + 1) + 1 + x] = grainValue(x, y);
		}
	}
	const idat = deflateSync(raw);
	cached = concat([
		sig,
		chunk('IHDR', ihdr),
		chunk('IDAT', new Uint8Array(idat)),
		chunk('IEND', new Uint8Array(0))
	]);
	return cached;
}
