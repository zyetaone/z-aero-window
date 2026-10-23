import { expect, test } from 'bun:test';
import { blindTitle, BLIND_DEPART_PX, dragCommits, pickOtherPlace } from './cabin.ts';

const IDS = ['dubai', 'mumbai', 'hyderabad'];

test('the closing blind names the next city only while the wall is moving on', () => {
	expect(blindTitle('dubai', 'mumbai', false, false)).toBe('dubai');
	expect(blindTitle('dubai', 'mumbai', true, false)).toBe('dubai → mumbai');
	expect(blindTitle('dubai', 'dubai', true, false)).toBe('dubai'); // a pinned place: no next to name
	expect(blindTitle('dubai', 'mumbai', true, true)).toBe('dubai'); // held (push or 'blind' mode): says where you are
	expect(blindTitle('mumbai', 'hyderabad', true, false)).toBe('mumbai → hyderabad');
});

test('a blind-drag departure never stays in the current place', () => {
	for (const u of [0, 0.25, 0.5, 0.75, 0.999]) expect(pickOtherPlace(IDS, 'dubai', u)).not.toBe('dubai');
});

test('the draw walks the remaining pool in order', () => {
	expect(pickOtherPlace(IDS, 'dubai', 0)).toBe('mumbai');
	expect(pickOtherPlace(IDS, 'dubai', 0.999)).toBe('hyderabad');
	expect(pickOtherPlace(IDS, 'no-such-place', 0)).toBe('dubai');
});

test('degenerate place tables fall back instead of crashing', () => {
	expect(pickOtherPlace(['dubai'], 'dubai', 0.5)).toBe('dubai');
	expect(pickOtherPlace([], null, 0.5)).toBe('');
});

test('departure needs a real pull, past the finger slop', () => {
	expect(BLIND_DEPART_PX).toBeGreaterThan(12); // adminQr's drag-vs-hold slop
	expect(dragCommits(BLIND_DEPART_PX)).toBe(false);
	expect(dragCommits(BLIND_DEPART_PX + 1)).toBe(true);
	expect(dragCommits(-200)).toBe(false);
});
