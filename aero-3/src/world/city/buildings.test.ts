import { expect, test } from 'bun:test';
import { capFootprints } from './buildings.ts';

// Identity projection: degrees are metres here, only ordering matters.
const project = (lon: number, lat: number): [number, number] => [lon, lat];
const fp = (x: number, size: number, height = 10) => ({
	geometry: { coordinates: [[[x, 0], [x + size, 0], [x + size, size], [x, size], [x, 0]]] },
	properties: { height }
});
const CAP = { maxCount: 10, coreM: 10_000, minAreaM2: 400 };

test('the core keeps everything, the outskirts only the large', () => {
	const nearShed = fp(100, 10); // area 100, dist 100: in core, kept
	const farShed = fp(20_000, 10); // area 100, past core, too small: dropped
	const farBlock = fp(20_000, 30); // area 900, past core, large: kept
	expect(capFootprints([nearShed, farShed, farBlock], project, { lon: 0, lat: 0 }, CAP)).toEqual([nearShed, farBlock]);
});

test('maxCount prefers near, then large', () => {
	const sheds = [500, 400, 300, 200, 100].map((x) => fp(x, 10));
	expect(capFootprints(sheds, project, { lon: 0, lat: 0 }, { ...CAP, maxCount: 3 }).map((f) => f.geometry.coordinates[0]![0]![0])).toEqual([100, 200, 300]);
});

test('capping is stable: the same pack deals the same city on every pane', () => {
	const pack = [900, 100, 20_000, 400, 30_000].map((x, i) => fp(x, 10 + i * 10));
	const [a, b] = [capFootprints(pack, project, { lon: 0, lat: 0 }, CAP), capFootprints(pack, project, { lon: 0, lat: 0 }, CAP)];
	expect(a).toEqual(b);
});
