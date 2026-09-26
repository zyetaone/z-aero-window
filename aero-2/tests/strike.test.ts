import { describe, it, expect } from 'vitest';
import { FLASH_PERIOD_SEC, slotNoise, strikeAt } from '#lib/display/flight/flight-path.js';

/** Strike second inside a slot, via the same schedule the renderer uses. */
const strikeSec = (slot: number) => slot * FLASH_PERIOD_SEC + slotNoise(slot) * 9 + 0.05;

describe('strikeAt', () => {
	it('is null outside the strike window and on garbage', () => {
		expect(strikeAt(0.5)).toBeNull();
		expect(strikeAt(12.9)).toBeNull();
		expect(strikeAt(NaN)).toBeNull();
		expect(strikeAt(Infinity)).toBeNull();
	});

	it('strikes once per slot, in the first 9 seconds', () => {
		for (let slot = 0; slot < 20; slot++) {
			const s = strikeAt(strikeSec(slot));
			expect(s, `slot ${slot} has no strike`).not.toBeNull();
		}
	});

	it('lands on the glass, biased to the sky half', () => {
		for (let slot = 0; slot < 20; slot++) {
			const s = strikeAt(strikeSec(slot));
			expect(s!.x01).toBeGreaterThanOrEqual(0);
			expect(s!.x01).toBeLessThan(1);
			expect(s!.y01).toBeGreaterThanOrEqual(0);
			expect(s!.y01).toBeLessThanOrEqual(0.66);
		}
	});

	it('is a pure function of the second — every pane strikes together', () => {
		const a = strikeAt(strikeSec(7));
		const b = strikeAt(strikeSec(7));
		expect(a).toEqual(b);
	});

	it('moves around the sky instead of striking one spot', () => {
		const xs = new Set<number>();
		for (let slot = 0; slot < 20; slot++) xs.add(strikeAt(strikeSec(slot))!.x01);
		expect(xs.size).toBeGreaterThan(5);
	});
});
