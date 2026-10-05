import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import { tintViirs } from '#lib/server/viirs-tint.js';

function solid(w: number, h: number, r: number, g: number, b: number, a: number): Uint8Array {
	const png = new PNG({ width: w, height: h });
	for (let i = 0; i < w * h; i++) {
		png.data[i * 4] = r;
		png.data[i * 4 + 1] = g;
		png.data[i * 4 + 2] = b;
		png.data[i * 4 + 3] = a;
	}
	return new Uint8Array(PNG.sync.write(png));
}

function read(bytes: Uint8Array): { r: number; g: number; b: number; a: number } {
	const png = PNG.sync.read(Buffer.from(bytes));
	return { r: png.data[0], g: png.data[1], b: png.data[2], a: png.data[3] };
}

describe('tintViirs', () => {
	it('masks black to transparent (the ground survives)', () => {
		const px = read(tintViirs(solid(4, 4, 0, 0, 0, 255)));
		expect(px.a).toBe(0);
	});

	it('passes transparency through untouched', () => {
		const px = read(tintViirs(solid(4, 4, 200, 200, 200, 0)));
		expect(px).toEqual({ r: 0, g: 0, b: 0, a: 0 });
	});

	it('turns white cores amber, never white', () => {
		const px = read(tintViirs(solid(4, 4, 255, 255, 255, 255)));
		expect(px.a).toBe(255);
		expect(px.r).toBeLessThanOrEqual(255);
		// No bucket deals pure white: the brightest pull (cool-white) still
		// leaves blue below red, and grain never pushes all three to 255.
		expect(px.r === 255 && px.g === 255 && px.b === 255).toBe(false);
	});

	it('deals neighbouring lamps into different palette buckets', () => {
		const out = PNG.sync.read(Buffer.from(tintViirs(solid(16, 16, 230, 230, 230, 255))));
		const seen = new Set<string>();
		for (let i = 0; i < 16 * 16; i++) {
			seen.add(`${out.data[i * 4]},${out.data[i * 4 + 1]},${out.data[i * 4 + 2]}`);
		}
		// One flat amber would be a single colour; the hash deals several.
		expect(seen.size).toBeGreaterThan(3);
	});

	it('sparks rare traffic-red in bright cores', () => {
		const out = PNG.sync.read(Buffer.from(tintViirs(solid(32, 32, 255, 255, 255, 255))));
		let reds = 0;
		for (let i = 0; i < 32 * 32; i++) {
			const r = out.data[i * 4];
			const g = out.data[i * 4 + 1];
			const b = out.data[i * 4 + 2];
			if (r > 180 && g < 120 && b < 90) reds++;
		}
		expect(reds).toBeGreaterThan(0);
		expect(reds).toBeLessThan(32 * 32 * 0.15);
	});

	it('is deterministic — same bytes in, same bytes out', () => {
		const input = solid(8, 8, 180, 170, 160, 255);
		expect(Buffer.from(tintViirs(input)).equals(Buffer.from(tintViirs(input)))).toBe(true);
	});

	it('ramps mids to partial alpha', () => {
		const px = read(tintViirs(solid(4, 4, 128, 128, 128, 255)));
		expect(px.a).toBeGreaterThan(0);
		expect(px.a).toBeLessThan(255);
	});

	it('knees the alpha at 0.35 luminance, not the old L^0.8', () => {
		/**
		 * The header used to claim `alpha = L^0.8`, which at L=0.35 is
		 * 0.35^0.8 ≈ 0.43 — visibly lit. The knee (smoothstep over
		 * L∈[0.35, 0.75]) gives exactly 0 there, which is the whole point:
		 * z8 VIIRS over a conurbation is mid-bright almost everywhere, and a
		 * low floor pasted a cream sheet over the city. These two pins make
		 * the header rot back to L^0.8 impossible without a red: below the
		 * knee start is fully transparent, at the knee end fully opaque.
		 */
		const below = read(tintViirs(solid(4, 4, 89, 89, 89, 255))); // L = 89/255 ≈ 0.349
		expect(below.a).toBe(0);
		const full = read(tintViirs(solid(4, 4, 191, 191, 191, 255))); // L = 191/255 ≈ 0.749
		expect(full.a).toBe(255);
	});
});
