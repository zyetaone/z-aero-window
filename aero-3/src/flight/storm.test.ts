import { expect, test } from 'bun:test';
import { flashAt, STRIKE_EVERY_SEC, strikeAt } from './storm.ts';

test('a strike flashes, dips, re-strikes and is gone within a second', () => {
	expect(flashAt(0.02)).toBe(1);
	expect(flashAt(0.08)).toBeLessThan(0.5);
	expect(flashAt(0.14)).toBeGreaterThan(0.5);
	expect(flashAt(0.9)).toBe(0);
	expect(flashAt(-0.1)).toBe(0);
});

test('every pane sees the same strike at the same wall second', () => {
	for (let t = 0; t < 200; t += 0.05) expect(strikeAt(42, 1_760_000_000 + t)).toEqual(strikeAt(42, 1_760_000_000 + t));
});

test('about one strike per STRIKE_EVERY_SEC, all in the storm around the pin', () => {
	const starts = new Set<number>();
	for (let t = 0; t < 3_600; t += 0.02) {
		const s = strikeAt(7, 1_760_000_000 + t);
		if (!s) continue;
		starts.add(s.startSec);
		expect(s.distM).toBeGreaterThanOrEqual(4_000);
		expect(s.distM).toBeLessThanOrEqual(30_000);
		expect(Math.hypot(s.x, s.z)).toBeCloseTo(s.distM, 3);
	}
	expect(starts.size).toBeGreaterThan(3_600 / STRIKE_EVERY_SEC / 2);
	expect(starts.size).toBeLessThan((3_600 / STRIKE_EVERY_SEC) * 2);
});

test('another day, another storm', () => {
	const at = (seed: number) => Array.from({ length: 600 }, (_, i) => strikeAt(seed, 1_760_000_000 + i * 0.1)?.startSec ?? 0).join();
	expect(at(1)).not.toBe(at(2));
});
