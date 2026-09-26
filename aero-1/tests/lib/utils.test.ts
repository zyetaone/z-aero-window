import { describe, it, expect } from 'vitest';
import { clamp, lerp, normalizeHeading, randomBetween, pickRandom, shortestAngleDelta, getSkyState, nightFactor, dawnDuskFactor, formatTime, readByPath, setByPath, T, formatAge } from '$lib/utils';

describe('clamp', () => {
	it('returns value within range', () => {
		expect(clamp(5, 0, 10)).toBe(5);
	});
	it('clamps to min', () => {
		expect(clamp(-5, 0, 10)).toBe(0);
	});
	it('clamps to max', () => {
		expect(clamp(15, 0, 10)).toBe(10);
	});
});

describe('lerp', () => {
	it('returns a at t=0', () => {
		expect(lerp(0, 100, 0)).toBe(0);
	});
	it('returns b at t=1', () => {
		expect(lerp(0, 100, 1)).toBe(100);
	});
	it('interpolates at midpoint', () => {
		expect(lerp(0, 100, 0.5)).toBe(50);
	});
});

describe('normalizeHeading', () => {
	it('keeps in-range value unchanged', () => {
		expect(normalizeHeading(180)).toBe(180);
	});
	it('wraps 360 to 0', () => {
		expect(normalizeHeading(360)).toBe(0);
	});
	it('wraps 720 to 0', () => {
		expect(normalizeHeading(720)).toBe(0);
	});
	it('wraps -90 to 270', () => {
		expect(normalizeHeading(-90)).toBe(270);
	});
});

describe('randomBetween', () => {
	it('returns within bounds', () => {
		for (let i = 0; i < 100; i++) {
			const v = randomBetween(10, 20);
			expect(v).toBeGreaterThanOrEqual(10);
			expect(v).toBeLessThanOrEqual(20);
		}
	});
});

describe('pickRandom', () => {
	it('returns an element from the array', () => {
		const arr = [1, 2, 3, 4, 5];
		for (let i = 0; i < 100; i++) {
			expect(arr).toContain(pickRandom(arr));
		}
	});
});

describe('shortestAngleDelta', () => {
	it('returns 0 for same angle', () => {
		expect(shortestAngleDelta(90, 90)).toBe(0);
	});
	it('returns positive delta for forward turn', () => {
		expect(shortestAngleDelta(0, 90)).toBe(90);
	});
	it('takes shortest path across 0/360 boundary', () => {
		expect(shortestAngleDelta(350, 10)).toBe(20);
		expect(shortestAngleDelta(10, 350)).toBe(-20);
	});
	it('handles 180° edge', () => {
		expect(Math.abs(shortestAngleDelta(0, 180))).toBe(180);
	});
});

// Sky-state functions use T thresholds as boundaries — tests stay in sync
// with T automatically; no manual updates needed when thresholds change.

describe('getSkyState', () => {
	it('night: before DAWN_START and from DUSK_END onward', () => {
		expect(getSkyState(0)).toBe('night');
		expect(getSkyState(T.DAWN_START - 0.1)).toBe('night');
		expect(getSkyState(T.DUSK_END)).toBe('night');
		expect(getSkyState(23.5)).toBe('night');
	});
	it('dawn: DAWN_START to DAY_START', () => {
		expect(getSkyState(T.DAWN_START)).toBe('dawn');
		expect(getSkyState(T.DAY_START - 0.1)).toBe('dawn');
	});
	it('day: DAY_START to DAY_END', () => {
		expect(getSkyState(T.DAY_START)).toBe('day');
		expect(getSkyState(12)).toBe('day');
		expect(getSkyState(T.DAY_END - 0.1)).toBe('day');
	});
	it('dusk: DAY_END to DUSK_END (blue hour included)', () => {
		expect(getSkyState(T.DAY_END)).toBe('dusk');
		expect(getSkyState(T.DUSK_END - 0.1)).toBe('dusk');
	});
});

describe('nightFactor', () => {
	it('returns 0 during full day', () => {
		expect(nightFactor(T.DAY_START)).toBe(0);
		expect(nightFactor(12)).toBe(0);
		expect(nightFactor(T.DAY_END)).toBe(0);
	});
	it('returns 1 before DAWN_START and after DEEP_NIGHT', () => {
		expect(nightFactor(0)).toBe(1);
		expect(nightFactor(T.DAWN_START - 0.1)).toBe(1);
		expect(nightFactor(T.DEEP_NIGHT + 0.1)).toBe(1);
	});
	it('ramps 1→0 through dawn (DAWN_START→DAY_START) with √-curve', () => {
		// √-curve: midpoint = √0.5 ≈ 0.707. Sky stays dark through early
		// dawn, brightens fast toward sunrise — matches real twilight.
		expect(nightFactor((T.DAWN_START + T.DAY_START) / 2)).toBeCloseTo(Math.sqrt(0.5), 5);
	});
	it('ramps 0→1 through dusk/night (DAY_END→DEEP_NIGHT) with √-curve', () => {
		// √-curve: midpoint = √0.5 ≈ 0.707. Sky dims fast after sunset,
		// plateaus toward deep night — matches civil/nautical twilight.
		expect(nightFactor((T.DAY_END + T.DEEP_NIGHT) / 2)).toBeCloseTo(Math.sqrt(0.5), 5);
	});
	it('√-curve accelerates dusk early: 25% wall-clock through reads as 50% night', () => {
		// At DAY_END + 25% of the dusk window, nightFactor reaches 0.5
		// (the linear curve would have given 0.25 — sky still bright).
		const quarterPoint = T.DAY_END + (T.DEEP_NIGHT - T.DAY_END) * 0.25;
		expect(nightFactor(quarterPoint)).toBeCloseTo(0.5, 5);
	});
	it('√-curve keeps dawn dark longer: 25% wall-clock through still reads as 87% night', () => {
		// At DAWN_START + 25% of the dawn window, nightFactor is still
		// √0.75 ≈ 0.866 (linear would have given 0.75 — sky too bright at 5:30 AM).
		const quarterPoint = T.DAWN_START + (T.DAY_START - T.DAWN_START) * 0.25;
		expect(nightFactor(quarterPoint)).toBeCloseTo(Math.sqrt(0.75), 5);
	});
});

describe('dawnDuskFactor', () => {
	it('returns 0 during full day and at transition extremes', () => {
		expect(dawnDuskFactor(T.DAY_START)).toBe(0);
		expect(dawnDuskFactor(12)).toBe(0);
		expect(dawnDuskFactor(T.DAY_END)).toBe(0);
		expect(dawnDuskFactor(T.DAWN_START)).toBe(0);
		expect(dawnDuskFactor(T.DEEP_NIGHT)).toBe(0);
		expect(dawnDuskFactor(0)).toBe(0);
	});
	it('is CONTINUOUS at the day boundaries — no 0→1 cliff (Jul-12 review)', () => {
		// The old curve peaked AT the boundaries: dd(18.01) ≈ 1 while dd(18) = 0,
		// a one-tick warm-grade pop at the most-watched hour. Now both sides of
		// each boundary are near-zero.
		expect(dawnDuskFactor(T.DAY_START - 0.01)).toBeLessThan(0.05);
		expect(dawnDuskFactor(T.DAY_END + 0.01)).toBeLessThan(0.05);
	});
	it('peaks at the authored hero times (dawn 06:30, dusk 18:30)', () => {
		expect(dawnDuskFactor(6.5)).toBeCloseTo(1, 5);
		expect(dawnDuskFactor(18.5)).toBeCloseTo(1, 5);
	});
	it('ramps as a triangle through each band', () => {
		expect(dawnDuskFactor(5.75)).toBeCloseTo(0.5, 5); // half-way up dawn rise
		expect(dawnDuskFactor(19.75)).toBeCloseTo(0.5, 5); // half-way down dusk fall
	});
});

describe('formatTime', () => {
	it('formats noon as 12:00 PM', () => {
		expect(formatTime(12)).toBe('12:00 PM');
	});
	it('formats midnight as 12:00 AM', () => {
		expect(formatTime(0)).toBe('12:00 AM');
	});
	it('formats half-hours', () => {
		expect(formatTime(14.5)).toBe('2:30 PM');
	});
	it('wraps 24 to midnight', () => {
		expect(formatTime(24)).toBe('12:00 AM');
	});
	it('handles negative times', () => {
		expect(formatTime(-1)).toBe('11:00 PM');
	});
});

describe('readByPath', () => {
	it('reads nested paths', () => {
		expect(readByPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
	});
	it('returns undefined for unknown keys', () => {
		expect(readByPath({ a: { b: 1 } } as Record<string, unknown>, 'a.z')).toBeUndefined();
	});
	it('returns undefined when traversal hits a non-object', () => {
		expect(readByPath({ a: 'not-an-object' } as Record<string, unknown>, 'a.b')).toBeUndefined();
	});
	it('rejects prototype-pollution paths', () => {
		const obj: Record<string, unknown> = { a: 1 };
		expect(readByPath(obj, '__proto__.x')).toBeUndefined();
		expect(readByPath(obj, 'constructor.prototype.x')).toBeUndefined();
		expect(readByPath(obj, 'prototype.x')).toBeUndefined();
	});
});

describe('setByPath', () => {
	it('writes nested paths that exist as own properties', () => {
		const obj = { a: { b: { c: 1 } } };
		expect(setByPath(obj, 'a.b.c', 42)).toBe(true);
		expect(obj.a.b.c).toBe(42);
	});

	it('returns false for unknown leaves (does not create new keys)', () => {
		const obj = { a: { b: { c: 1 } } };
		expect(setByPath(obj, 'a.b.newkey', 42)).toBe(false);
		expect('newkey' in obj.a.b).toBe(false);
	});

	it('returns false when traversal hits a non-object', () => {
		const obj = { a: { b: 'not-an-object' } };
		expect(setByPath(obj, 'a.b.c', 42)).toBe(false);
	});

	// Prototype-pollution defense — the entire reason setByPath is hardened.
	it('rejects __proto__ as any path segment', () => {
		const obj: Record<string, unknown> = { a: 1 };
		expect(setByPath(obj, '__proto__.polluted', 'pwned')).toBe(false);
		expect(setByPath(obj, 'a.__proto__.polluted', 'pwned')).toBe(false);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(({} as any).polluted).toBeUndefined();
	});

	it('rejects constructor.prototype paths', () => {
		const obj: Record<string, unknown> = { a: 1 };
		expect(setByPath(obj, 'constructor.prototype.polluted', 'pwned')).toBe(false);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		expect(({} as any).polluted).toBeUndefined();
	});

	it('rejects bare prototype segment', () => {
		const obj: Record<string, unknown> = { a: 1 };
		expect(setByPath(obj, 'prototype.x', 'pwned')).toBe(false);
	});

	it('uses Object.hasOwn — does not walk through prototype-chain keys', () => {
		const obj: Record<string, unknown> = { a: 1 };
		expect(setByPath(obj, 'toString.length', 42)).toBe(false);
	});

	it('rejects writes into a frozen container instead of throwing', () => {
		// director.autopilot.weatherPool is Object.freeze'd; a config patch to
		// '...weatherPool.0' reaches the write through a $state proxy, which
		// throws TypeError in strict mode — that 500'd PATCH /api/config.
		const obj = { pool: Object.freeze(['clear', 'rain']) };
		expect(setByPath(obj as unknown as Record<string, unknown>, 'pool.0', 'storm')).toBe(false);
		expect(obj.pool[0]).toBe('clear');
	});
});

describe('formatAge', () => {
	it('says just now under ten seconds', () => {
		expect(formatAge(9_500, 10_000)).toBe('just now');
	});
	it('counts seconds and minutes with ago', () => {
		expect(formatAge(0, 45_000)).toBe('45s ago');
		expect(formatAge(0, 90_000)).toBe('1m ago');
	});
	it('counts hours', () => {
		expect(formatAge(0, 7_200_000)).toBe('2h ago');
	});
});
