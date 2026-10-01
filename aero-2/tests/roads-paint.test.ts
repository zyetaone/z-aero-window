import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	CASING_COLOR,
	LAMP_COLOR,
	SNAP,
	VIIRS_GLOW,
	lampOpacity,
	withViirsAlpha
} from '#lib/display/world/roads-paint.js';

/**
 * The contract that stops `city-roads` reloading five times a second:
 * everything reactive on a road layer is a plain number, and the only
 * expression that reads a feature property is the colour, set once.
 * (maplibre-gl 6.6.0 `StyleLayer.setPaintProperty` returns true — and
 * `Style._updateLayer` reloads the source — whenever the old OR new value
 * is data-driven.)
 */

/** Does an expression, anywhere in its tree, read a feature property? */
function readsFeature(expr: unknown): boolean {
	if (!Array.isArray(expr)) return false;
	if (expr[0] === 'get' || expr[0] === 'feature-state') return true;
	return expr.some(readsFeature);
}

describe('lampOpacity', () => {
	it('is always a plain number on the 0.01 grid, clamped to [0, 1]', () => {
		for (const factors of [
			[0.55, 0.73, 0.91],
			[0.22, 1],
			[0.75, 0],
			[0.9, 1.7],
			[0.4, -0.2]
		]) {
			const v = lampOpacity(...factors);
			expect(typeof v).toBe('number');
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
			// Quantised to the 0.01 grid, but NOT exactly representable there:
			// quantize(0.345) is 0.35000000000000003. Asserting exact equality
			// here would only pass because the chosen inputs happen to land
			// clean, and it advertises a guarantee the code does not make. The
			// bound is what MapLibre actually cares about.
			expect(Math.abs(v * 100 - Math.round(v * 100))).toBeLessThan(1e-9);
		}
	});

	it('returns a finite number in range for non-finite input', () => {
		// A NaN reaching line-opacity makes MapLibre drop the layer, so the
		// road lamps would vanish with no error. Guarded, and tested.
		for (const bad of [NaN, Infinity, -Infinity]) {
			const v = lampOpacity(0.55, bad, 0.99);
			expect(Number.isFinite(v)).toBe(true);
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
		}
	});

	it('multiplies its factors before quantising (one rounding, not one per factor)', () => {
		expect(lampOpacity(0.55, 0.9)).toBe(0.5);
		expect(lampOpacity(0.55, 0.9, 0.9)).toBe(0.45);
	});
});

describe('colour carries the VIIRS gain', () => {
	it('withViirsAlpha puts the per-road gain in the alpha channel', () => {
		expect(withViirsAlpha('#ffb959')).toEqual(['rgba', 255, 185, 89, VIIRS_GLOW]);
		expect(VIIRS_GLOW).toEqual(['coalesce', ['get', 'glow'], 1]);
		expect(() => withViirsAlpha('#fff')).toThrow();
	});

	it('every colour output is data-driven; the casing too', () => {
		// match: [op, input, label, out, label, out, ..., fallback]
		const tail = LAMP_COLOR.slice(2);
		const outputs = [...tail.filter((_, i) => i % 2 === 1), tail[tail.length - 1]];
		expect(outputs).toHaveLength(4);
		for (const out of outputs) expect(readsFeature(out)).toBe(true);
		expect(readsFeature(CASING_COLOR)).toBe(true);
	});

	it('the shimmer step is not eased by a paint transition', () => {
		expect(SNAP).toEqual({ duration: 0 });
	});
});

describe('Roads.svelte wiring', () => {
	const code = readFileSync('src/lib/display/world/Roads.svelte', 'utf8');

	it('no opacity derived is an expression — every one goes through lampOpacity', () => {
		const opacityDeriveds = [...code.matchAll(/const (\w+Opacity) = \$derived\(([^;]+)\);/g)];
		expect(opacityDeriveds.length).toBeGreaterThanOrEqual(7);
		for (const [, name, body] of opacityDeriveds) {
			expect(body, name).toMatch(/^lampOpacity\(/);
			expect(body, name).not.toMatch(/\[/);
		}
	});

	it("no 'line-opacity' is bound to an expression literal or a bare product", () => {
		for (const [, value] of code.matchAll(/'line-opacity': ([^,\n]+)/g)) {
			expect(value).toMatch(/^\w+Opacity$/);
		}
	});

	it('the feature-reading gain is never rebuilt reactively', () => {
		expect(code).not.toMatch(/\$derived\([^)]*\['get'/);
		expect(code).not.toContain('viirsGlow');
	});
});
