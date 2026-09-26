import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every `beforeId` must name a layer id that actually exists.
 *
 * Shipped once with `beforeId="gibs"` — a SOURCE id; the raster layers
 * carried auto-generated `svmlgl-layer-N` ids, so `addLayer` threw and the
 * night-stars and sun/moon custom layers never mounted. No error surfaced:
 * the sky simply had no stars and nobody could tell from any test. Layer
 * ids are addresses — this test resolves them.
 */
function worldSources(): { file: string; code: string }[] {
	const dir = 'src/lib/display/world';
	return readdirSync(dir)
		.filter((f) => f.endsWith('.svelte'))
		.map((file) => ({ file, code: readFileSync(join(dir, file), 'utf8') }));
}

describe('custom layer addresses', () => {
	it('every beforeId resolves to a declared layer id', () => {
		const files = worldSources();
		const declared = new Set<string>();
		for (const { code } of files) {
			for (const m of code.matchAll(
				/<(?:Raster|Fill|FillExtrusion|Line|Circle|Symbol|Hillshade|Heatmap|Background|Custom)Layer\b[^>]*\bid="([^"]+)"/g
			)) {
				declared.add(m[1]);
			}
		}
		for (const { file, code } of files) {
			for (const m of code.matchAll(/beforeId="([^"]+)"/g)) {
				expect(declared.has(m[1]), `${file}: beforeId="${m[1]}" names no layer`).toBe(true);
			}
		}
		expect(declared.size).toBeGreaterThan(0);
	});

	it('in-map sky layers mount before the ground photograph', () => {
		const files = worldSources();
		const byId = new Map(files.map(({ file, code }) => [file, code]));
		for (const id of ['night-stars', 'sun-moon']) {
			const hit = [...byId.entries()].find(([, code]) => code.includes(`id="${id}"`));
			expect(hit, `layer ${id} exists`).toBeTruthy();
			expect(hit![1]).toContain('beforeId="gibs-day"');
		}
	});
});
