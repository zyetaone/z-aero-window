import { expect, test } from 'bun:test';
import { nightTerms } from './clouds.ts';

test('by day the night terms are exactly zero: day rendering is bit-identical', () => {
	// moonGain and cityGlow both carry the dark (moonlightAt, dark x lights), so day passes 0, 0.
	expect(nightTerms(0.5, 0, 0, 0)).toEqual({ moonBody: 0, city: 0 });
	expect(nightTerms(-1, 0, 0, 100_000)).toEqual({ moonBody: 0, city: 0 });
});

test('a full high moon lights the body and the moon side', () => {
	// moonlightAt at full high moon: 0.4 x 1 x (0.25 + 0.75) = 0.4.
	expect(nightTerms(1, 0.4, 0, 0).moonBody).toBeCloseTo(0.55 * 0.4 + 0.4);
	expect(nightTerms(-1, 0.4, 0, 0).moonBody).toBeCloseTo(0.55 * 0.4); // turned away: base only
	expect(nightTerms(1, 0.1, 0, 0).moonBody).toBeCloseTo(0.55 * 0.1 + 0.1); // new moon: dim, not black
});

test('city glow is brightest over the pin and gone by 60 km', () => {
	expect(nightTerms(0, 0, 1, 0).city).toBeCloseTo(1);
	expect(nightTerms(0, 0, 1, 60_000).city).toBeLessThan(0.05);
	expect(nightTerms(0, 0, 1, 60_000).city).toBeGreaterThan(0); // falls off, never cliffs
});

test('a moonlit city cloud reads grey-blue, not black', () => {
	// Full high moon (gain 0.4) over a lit city (glow ~1): the terms the old code never had.
	const { moonBody, city } = nightTerms(0.5, 0.4, 1, 5_000);
	// moonBody x shade (~0.84) x MOON blue (1.0) ≈ 0.35: ten times the old 0.03 floor.
	expect(moonBody * 0.84).toBeGreaterThan(0.3);
	expect(city).toBeCloseTo(Math.exp(-((5_000 / 30_000) ** 2)));
});
