import { expect, test } from 'bun:test';
import { flight } from './flight.ts';

test('a flight is pure in (seed, second), closes its loop, and sits on the inside of its turn', () => {
	const [a, b] = [flight(42, 9_000), flight(42, 9_000)];
	expect(a.pose(1234.5)).toEqual(b.pose(1234.5));
	const [x0, z0] = a.at(0);
	const [x1, z1] = a.at(a.periodSec);
	expect(Math.hypot(x1 - x0, z1 - z0)).toBeLessThan(1);
	for (const sec of [0, 300, 700]) {
		const p = a.pose(sec);
		expect(Math.sign(p.bank)).toBe(Math.sign(Math.sin(p.look))); // banked toward the window that looks in
	}
});

test('altitude varies by visit and climbs or descends smoothly within one', () => {
	const cruises = Array.from({ length: 40 }, (_, i) => flight(i * 7919, 9_000).cruiseM);
	expect(Math.min(...cruises)).toBeGreaterThan(2_500); // over the cloud deck
	expect(Math.max(...cruises)).toBeLessThan(10_000);
	expect(Math.max(...cruises) - Math.min(...cruises)).toBeGreaterThan(4_000); // the bands really differ
	const f = flight(42, 9_000);
	for (let s = 1; s < 600; s += 7) expect(Math.abs(f.pose(s).climbM - f.pose(s - 1).climbM)).toBeLessThan(15); // no jumps: < 15 m/s
});
