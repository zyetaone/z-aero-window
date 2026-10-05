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
