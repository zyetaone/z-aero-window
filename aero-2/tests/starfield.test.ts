import { describe, it, expect } from 'vitest';
import {
	buildStarField,
	STAR_COUNT,
	STAR_SHELL_M,
	starShellElevation,
	bvToTemp,
	lngLatToMercator01
} from '#lib/display/world/starfield.js';
import { YALE_STAR_COUNT, yaleCatalog } from '#lib/display/world/yale-stars.js';

describe('yaleCatalog', () => {
	it('vends the whole naked-eye sky: 8,404 stars at Vmag ≤ 6.5', () => {
		expect(YALE_STAR_COUNT).toBe(8404);
		expect(STAR_COUNT).toBe(YALE_STAR_COUNT);
		const cat = yaleCatalog();
		expect(cat.ra.length).toBe(8404);
		expect(cat.dec.length).toBe(8404);
		expect(cat.vmag.length).toBe(8404);
		expect(cat.bv.length).toBe(8404);
	});

	it('decodes Sirius as the brightest star (quantized, so tolerant)', () => {
		const cat = yaleCatalog();
		let bi = 0;
		for (let i = 1; i < YALE_STAR_COUNT; i++) if (cat.vmag[i] < cat.vmag[bi]) bi = i;
		expect(cat.vmag[bi]).toBeCloseTo(-1.46, 1);
		expect(cat.ra[bi]).toBeCloseTo(101.287, 1);
		expect(cat.dec[bi]).toBeCloseTo(-16.716, 1);
	});

	it('holds Vega where the almanac says', () => {
		const cat = yaleCatalog();
		let found = false;
		for (let i = 0; i < YALE_STAR_COUNT; i++) {
			if (Math.abs(cat.vmag[i] - 0.03) < 0.03 && Math.abs(cat.ra[i] - 279.235) < 0.05) {
				expect(cat.dec[i]).toBeCloseTo(38.784, 1);
				found = true;
				break;
			}
		}
		expect(found).toBe(true);
	});

	it('spans blue giants to red embers, all in physical ranges', () => {
		const cat = yaleCatalog();
		let minBv = Infinity;
		let maxBv = -Infinity;
		for (let i = 0; i < YALE_STAR_COUNT; i++) {
			expect(cat.ra[i]).toBeGreaterThanOrEqual(0);
			expect(cat.ra[i]).toBeLessThanOrEqual(360);
			expect(cat.dec[i]).toBeGreaterThanOrEqual(-90);
			expect(cat.dec[i]).toBeLessThanOrEqual(90);
			expect(cat.vmag[i]).toBeLessThanOrEqual(6.5);
			expect(cat.bv[i]).toBeGreaterThanOrEqual(-0.5);
			expect(cat.bv[i]).toBeLessThanOrEqual(2.5);
			minBv = Math.min(minBv, cat.bv[i]);
			maxBv = Math.max(maxBv, cat.bv[i]);
		}
		expect(minBv).toBeLessThan(0);
		expect(maxBv).toBeGreaterThan(1.5);
	});

	it('returns the same decoded sky every call', () => {
		expect(yaleCatalog()).toBe(yaleCatalog());
	});
});

describe('bvToTemp', () => {
	it('lands the Sun near 5778 K', () => {
		expect(bvToTemp(0.65)).toBeCloseTo(5778, -2);
	});

	it('orders ember < sun < blue giant, inside the shader range', () => {
		const ember = bvToTemp(1.8);
		const sun = bvToTemp(0.65);
		const blue = bvToTemp(-0.3);
		expect(ember).toBeLessThan(sun);
		expect(sun).toBeLessThan(blue);
		for (const t of [ember, sun, blue]) {
			expect(t).toBeGreaterThanOrEqual(2500);
			expect(t).toBeLessThanOrEqual(30000);
		}
	});
});

describe('starShellElevation', () => {
	/**
	 * `farZ` used to pull the shell down via `Math.min(STAR_SHELL_M, farZ *
	 * 0.25)`, and the test that pinned it was called "pulls the shell inside a
	 * tight far plane instead of clipping" — a rationale `Starfield.svelte`'s
	 * own shader comment already refutes: "the old farZ guard only moved the
	 * shell nearer, which cannot help — distance, not height, is what exceeds
	 * far." The shader keeps x/y and substitutes z, so farZ cannot reach the
	 * directions at all.
	 */
	it('ignores farZ entirely, however hostile', () => {
		for (const f of [1e9, 4_000_000, 750_000, 1, NaN, 0, -10, Infinity]) {
			expect(starShellElevation(f)).toBe(STAR_SHELL_M);
		}
	});
});

/**
 * The geometry the shell height exists to satisfy.
 *
 * A star's apparent altitude comes from a finite sphere, not from astronomy: at
 * shell radius r the whole sky folds into a cap of half-angle acos(R / r). The
 * shipped 188 m... 188 KM shell put a star meant for 60° above the horizon at
 * −12°, underground, and the constant that was supposed to prevent that was
 * dead code. This is the assertion that keeps it dead-code-free: it fails if
 * anyone reintroduces a clamp, whatever they call it.
 */
describe('the shell is far enough to be a sky', () => {
	const R_M = 6_371_000;
	const CAMERA_M = 10_000;

	/** Where a star intended at `trueAltDeg` actually renders. */
	const renderedAlt = (trueAltDeg: number, shellM: number): number => {
		const theta = ((90 - trueAltDeg) * Math.PI) / 180;
		const vert = (R_M + shellM) * Math.cos(theta) - (R_M + CAMERA_M);
		const horiz = (R_M + shellM) * Math.sin(theta);
		return (Math.atan2(vert, horiz) * 180) / Math.PI;
	};

	it('keeps every star within 1 degree of where it belongs', () => {
		const shell = starShellElevation(750_000);
		for (let alt = 5; alt <= 85; alt += 5) {
			expect(Math.abs(renderedAlt(alt, shell) - alt), `star at ${alt}deg`).toBeLessThan(1);
		}
	});

	it('stays under the J2000 precession this catalogue already ignores', () => {
		// yale-stars.ts declines to precess on the grounds that 1.4 deg is
		// invisible here. A shell coarser than that would contradict it.
		const worst = Math.max(
			...Array.from({ length: 17 }, (_, i) => {
				const alt = 5 + i * 5;
				return Math.abs(renderedAlt(alt, starShellElevation(750_000)) - alt);
			})
		);
		expect(worst).toBeLessThan(1.4);
	});

	it('would have failed on the shell that shipped', () => {
		expect(renderedAlt(60, 188_000)).toBeLessThan(0); // below the horizon
	});
});

describe('buildStarField', () => {
	it('emits the catalogue with in-range attributes', () => {
		const f = buildStarField();
		expect(f.xy.length).toBe(STAR_COUNT * 2);
		expect(f.size.length).toBe(STAR_COUNT);
		expect(f.mag.length).toBe(STAR_COUNT);
		expect(f.phase.length).toBe(STAR_COUNT);
		expect(f.temp.length).toBe(STAR_COUNT);
		for (let i = 0; i < STAR_COUNT; i++) {
			expect(f.xy[i * 2]).toBeGreaterThanOrEqual(0);
			expect(f.xy[i * 2]).toBeLessThanOrEqual(1);
			expect(f.xy[i * 2 + 1]).toBeGreaterThanOrEqual(0);
			expect(f.xy[i * 2 + 1]).toBeLessThanOrEqual(1);
			// Float32-stored, so bounds carry an epsilon.
			expect(f.size[i]).toBeGreaterThanOrEqual(0.9 - 1e-6);
			expect(f.size[i]).toBeLessThanOrEqual(3.2 + 1e-6);
			expect(f.mag[i]).toBeGreaterThanOrEqual(0.3 - 1e-6);
			expect(f.mag[i]).toBeLessThanOrEqual(1 + 1e-6);
			expect(f.phase[i]).toBeGreaterThanOrEqual(0);
			expect(f.phase[i]).toBeLessThanOrEqual(Math.PI * 2);
			expect(f.temp[i]).toBeGreaterThanOrEqual(2500);
			expect(f.temp[i]).toBeLessThanOrEqual(30000);
		}
	});

	it('is deterministic — same bytes, same sky on every pane', () => {
		const a = buildStarField();
		const b = buildStarField();
		expect(a.xy).toEqual(b.xy);
		expect(a.size).toEqual(b.size);
		expect(a.mag).toEqual(b.mag);
		expect(a.phase).toEqual(b.phase);
		expect(a.temp).toEqual(b.temp);
	});

	it('draws bright stars bigger and more opaque than dim ones', () => {
		const cat = yaleCatalog();
		const f = buildStarField();
		let bi = 0;
		let di = 0;
		for (let i = 1; i < STAR_COUNT; i++) {
			if (cat.vmag[i] < cat.vmag[bi]) bi = i;
			if (cat.vmag[i] > cat.vmag[di]) di = i;
		}
		expect(f.size[bi]).toBeGreaterThan(f.size[di]);
		expect(f.mag[bi]).toBeGreaterThan(f.mag[di]);
	});

	it('puts Sirius at its catalogue position through the mercator path', () => {
		const cat = yaleCatalog();
		let bi = 0;
		for (let i = 1; i < STAR_COUNT; i++) if (cat.vmag[i] < cat.vmag[bi]) bi = i;
		const f = buildStarField();
		const [mx, my] = lngLatToMercator01(cat.ra[bi] - 180, cat.dec[bi]);
		expect(f.xy[bi * 2]).toBeCloseTo(mx, 5);
		expect(f.xy[bi * 2 + 1]).toBeCloseTo(my, 5);
		// And Sirius sits at RA ~101.3°, i.e. x ≈ 0.28 — independent of the helper.
		expect(f.xy[bi * 2]).toBeCloseTo(101.287 / 360, 2);
	});

	it('covers the whole celestial sphere, not one patch', () => {
		const f = buildStarField();
		let minX = 1;
		let maxX = 0;
		for (let i = 0; i < STAR_COUNT; i++) {
			minX = Math.min(minX, f.xy[i * 2]);
			maxX = Math.max(maxX, f.xy[i * 2]);
		}
		// Real RA spans the full circle.
		expect(maxX - minX).toBeGreaterThan(0.9);
	});
});
