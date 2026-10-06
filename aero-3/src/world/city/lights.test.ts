import { expect, test } from 'bun:test';
import { thinStreetLamps } from './lights.ts';

const lamp = (x: number, z: number): number[] => [x, 10, z, 1, 0.62, 0.25];
const grid = (n: number, step: number): number[] => Array.from({ length: n }, (_, i) => lamp((i % 10) * step, Math.floor(i / 10) * step)).flat();

test('under budget the list passes through untouched', () => {
	const lamps = grid(50, 100);
	const { kept, dropped } = thinStreetLamps(lamps, 0, 0, 150_000, 10_000);
	expect(kept).toEqual(lamps);
	expect(dropped).toBe(0);
});

test('over budget the core stays whole and the outskirts share the rest', () => {
	const lamps = grid(400, 1_000); // 10x10 km at 1 km: some inside a 5 km core, most outside
	const { kept, dropped } = thinStreetLamps(lamps, 0, 0, 200, 5_000);
	expect(kept.length / 6 + dropped).toBe(400);
	expect(kept.length / 6).toBeLessThanOrEqual(200);
	// Every lamp within the core survived: find the input's inside-core count in the output.
	const inside = (list: number[]) => list.filter((_, i) => i % 6 === 0 && Math.hypot(list[i]!, list[i + 2]!) <= 5_000).length;
	expect(inside(kept)).toBe(inside(lamps));
});

test('a core that alone overflows thins evenly, and stably across panes', () => {
	const lamps = grid(400, 100); // all inside a 5 km core
	const [a, b] = [thinStreetLamps(lamps, 0, 0, 200, 5_000), thinStreetLamps(lamps, 0, 0, 200, 5_000)];
	expect(a.kept.length / 6).toBe(200);
	expect(a.kept).toEqual(b.kept); // position hashes, no randomness: panes agree
	expect(a.dropped).toBeGreaterThan(0);
});
