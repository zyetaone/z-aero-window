import { describe, it, expect } from 'vitest';
import { glowColor, heightRampRgb } from '../tools/stamp-building-glow.mjs';

describe('heightRampRgb', () => {
	it('reads ember at the ground and warm white at tower tops', () => {
		expect(heightRampRgb(0)).toEqual([0x7c, 0x2d, 0x12]);
		const top = heightRampRgb(300);
		expect(top[0]).toBe(0xff);
		expect(top[1]).toBeGreaterThan(0xe0);
		expect(top[2]).toBeGreaterThan(0xd0);
	});

	it('climbs monotonically with height', () => {
		let prev = -1;
		for (const h of [0, 10, 30, 60, 120, 225, 500]) {
			const lum = heightRampRgb(h).reduce((a, c) => a + c, 0);
			expect(lum).toBeGreaterThan(prev);
			prev = lum;
		}
	});
});

describe('glowColor', () => {
	it('glows full at the lit core', () => {
		expect(glowColor(300, 1)).toBe('#fff3df');
		expect(glowColor(225, 1)).toBe('#ffeccf');
	});

	it('embers out at the dark rim, whatever the height', () => {
		// Rim keeps 20% of the ramp (a hint of form), never full ember.
		expect(glowColor(225, 0)).toBe('#553e30');
		expect(glowColor(0, 0)).toBe('#3a170a');
	});

	it('dims toward ember as glow falls', () => {
		const lum = (hex: string) => {
			const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
			return c[0] + c[1] + c[2];
		};
		expect(lum(glowColor(100, 1))).toBeGreaterThan(lum(glowColor(100, 0.5)));
		expect(lum(glowColor(100, 0.5))).toBeGreaterThan(lum(glowColor(100, 0)));
	});

	it('emits valid hex', () => {
		for (const h of [0, 9.6, 30, 225]) {
			for (const g of [0, 0.5, 1]) {
				expect(glowColor(h, g)).toMatch(/^#[0-9a-f]{6}$/);
			}
		}
	});
});
