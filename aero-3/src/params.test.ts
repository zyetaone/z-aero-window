import { expect, test } from 'bun:test';
import { readParams } from './params.ts';

test('defaults for a bare URL, a wall pane hides the HUD, junk numbers fall back', () => {
	const bare = readParams('');
	expect([bare.role, bare.blind, bare.hud, bare.sky, bare.scale, bare.yaw]).toEqual([null, true, true, 1.7, 1, null]);
	expect(Number.isNaN(bare.alt) && Number.isNaN(bare.clock)).toBe(true);
	const pane = readParams('?role=left&wall=http://10.0.0.2:3300&scale=abc&blind=0&role=nonsense');
	expect([pane.role, pane.hud, pane.scale, pane.blind, pane.wall]).toEqual(['left', false, 1, false, 'http://10.0.0.2:3300']);
	expect(readParams('?role=hacker').role).toBeNull();
	expect(readParams('?scale=0.01').scale).toBe(0.25);
});
