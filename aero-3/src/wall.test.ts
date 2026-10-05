import { expect, test } from 'bun:test';
import { parsePush, PRESETS } from './wall.ts';

test('a push takes known places, regimes and hours, and nothing else', () => {
	expect(parsePush({ place: 'dubai', weather: 'hazy', clock: 21.5 })).toEqual({ place: 'dubai', weather: 'hazy', clock: 21.5 });
	expect(parsePush({})).toEqual({ place: null, weather: null, clock: null });
	expect(parsePush({ place: 'constructor' })).toBeNull();
	expect(parsePush({ place: '../etc' })).toBeNull();
	expect(parsePush({ weather: 'snow' })).toBeNull();
	expect(parsePush({ clock: 25 })).toBeNull();
	expect(parsePush({ clock: '9' })).toBeNull();
	expect(parsePush(null)).toBeNull();
});

test('every preset is a push the server would accept', () => {
	for (const [name, push] of Object.entries(PRESETS)) expect(parsePush(push), name).toEqual(push);
});
