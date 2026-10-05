import { expect, test } from 'bun:test';
import { destinationAt, DWELL_SEC } from './places.ts';

test('one city per dwell slot, and every rotation city in each eight-slot cycle', () => {
	const day = 20_000 * 86_400; // a slot-aligned day start
	expect(destinationAt(day)).toBe(destinationAt(day + DWELL_SEC - 1));
	const cycle = new Set(Array.from({ length: 8 }, (_, i) => destinationAt(day + i * DWELL_SEC)));
	expect(cycle.size).toBe(8);
	expect(cycle.has('himalayas')).toBe(false);
});
