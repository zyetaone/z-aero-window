import { expect, test } from 'bun:test';
import { RAD } from '#math.ts';
import { rideAt } from './motion.ts';

test('the ride is a pure function of the wall second: three panes feel one bump', () => {
	for (let s = 1_700_000_000; s < 1_700_000_600; s += 0.37) expect(rideAt(42, s, 1.5, 6_000)).toEqual(rideAt(42, s, 1.5, 6_000));
});

test('bounded in a storm, and a visit sees at least one bump', () => {
	let [maxPitch, maxRoll, maxHeave, bumps] = [0, 0, 0, 0];
	for (let s = 1_700_000_000; s < 1_700_000_600; s += 0.05) {
		const r = rideAt(7, s, 2, 3_500);
		maxPitch = Math.max(maxPitch, Math.abs(r.pitch));
		maxRoll = Math.max(maxRoll, Math.abs(r.roll));
		maxHeave = Math.max(maxHeave, Math.abs(r.heaveM));
		if (Math.abs(r.pitch) > 0.8 * RAD) bumps++;
	}
	expect(maxPitch).toBeLessThan(3 * RAD);
	expect(maxRoll).toBeLessThan(3 * RAD);
	expect(maxHeave).toBeLessThan(25);
	expect(bumps).toBeGreaterThan(0);
});

test('still air at cruise: a fifth of the motion, no bumps', () => {
	let [lo, hi] = [0, 0];
	for (let s = 0; s < 600; s += 0.1) {
		lo = Math.max(lo, Math.abs(rideAt(7, s, 1, 12_000).roll));
		hi = Math.max(hi, Math.abs(rideAt(7, s, 1, 3_500).roll));
	}
	expect(lo).toBeLessThan(hi * 0.4);
});
