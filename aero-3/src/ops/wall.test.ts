import { expect, test } from 'bun:test';
import { MAX_MEDIA_IDS, MAX_PUSH_BYTES, NO_GAINS, NO_MEDIA, parsePush, PRESETS } from './wall.ts';

test('a push takes known places, regimes and hours, and nothing else', () => {
	expect(parsePush({ place: 'dubai', weather: 'hazy', clock: 21.5 })).toEqual({ place: 'dubai', weather: 'hazy', clock: 21.5, alt: null, scale: null, gains: { ...NO_GAINS }, media: { audio: [], video: null }, mode: null });
	expect(parsePush({})).toEqual({ place: null, weather: null, clock: null, alt: null, scale: null, gains: { ...NO_GAINS }, media: { ...NO_MEDIA }, mode: null });
	expect(parsePush({ place: 'constructor' })).toBeNull();
	expect(parsePush({ place: '../etc' })).toBeNull();
	expect(parsePush({ weather: 'snow' })).toBeNull();
	expect(parsePush({ clock: 25 })).toBeNull();
	expect(parsePush({ clock: '9' })).toBeNull();
	expect(parsePush(null)).toBeNull();
});

test('altitude and render scale round-trip inside their ranges, and nothing else', () => {
	expect(parsePush({ alt: 3_500, scale: 2 })).toMatchObject({ alt: 3_500, scale: 2 });
	for (const bad of [{ alt: 100 }, { alt: 20_000 }, { alt: '3500' }, { scale: 0.5 }, { scale: 4 }, { scale: Number.NaN }]) expect(parsePush(bad), JSON.stringify(bad)).toBeNull();
});

test('every preset is a push the server would accept', () => {
	for (const [name, push] of Object.entries(PRESETS)) expect(parsePush(push), name).toEqual(push);
});

test('gains are optional and default to null (the pane keeps its own)', () => {
	expect(parsePush({})!.gains).toEqual({ ...NO_GAINS });
	expect(parsePush({ gains: null })!.gains).toEqual({ ...NO_GAINS });
	expect(parsePush({ gains: undefined })!.gains).toEqual({ ...NO_GAINS });
	expect(parsePush({ gains: {} })!.gains).toEqual({ ...NO_GAINS });
});

test('gains round-trip inside their slider ranges', () => {
	const gains = { street: 1.5, building: 0, far: 2, haze: 0.3, glow: 1, volume: 0.4 };
	expect(parsePush({ gains })).toEqual({ place: null, weather: null, clock: null, alt: null, scale: null, gains, media: { audio: [], video: null }, mode: null });
});

test('a bad gain fails the whole push, like a bad place or hour', () => {
	for (const gains of [
		{ street: 2.5 },
		{ building: -0.1 },
		{ far: Number.NaN },
		{ haze: 1.5 },
		{ glow: Number.POSITIVE_INFINITY },
		{ volume: 1.2 },
		{ street: '1' },
		{ haze: true },
		'bright',
		[1]
	])
		expect(parsePush({ place: 'dubai', gains }), JSON.stringify(gains)).toBeNull();
});

test('a maximal gains push stays far under the 1024-byte wall budget', () => {
	const push = parsePush({ place: 'himalayas', weather: 'towering', clock: 21.5, gains: { street: 2, building: 2, far: 2, haze: 1, glow: 1, volume: 1 } })!;
	expect(JSON.stringify(push).length).toBeLessThan(MAX_PUSH_BYTES);
});

test('media defaults to silence: no tracks, no clip', () => {
	expect(parsePush({})!.media).toEqual({ audio: [], video: null });
	expect(parsePush({ media: null })!.media).toEqual({ audio: [], video: null });
	expect(parsePush({ media: {} })!.media).toEqual({ audio: [], video: null });
});

test('media carries short store IDs, never URLs', () => {
	const media = { audio: ['dawn.mp3', 'night.ogg'], video: 'clip.mp4' };
	expect(parsePush({ media })!.media).toEqual(media);
});

test('a bad media field fails the whole push', () => {
	for (const media of [
		{ audio: ['/api/media/x.mp3'] },
		{ audio: ['https://cdn.example/x.mp3'] },
		{ audio: ['../wall.json'] },
		{ audio: ['ok.mp3', 7] },
		{ audio: ['ok.mp3', null] },
		{ audio: Array.from({ length: MAX_MEDIA_IDS + 1 }, (_, i) => `${i}.mp3`) },
		{ audio: 'dawn.mp3' },
		{ video: '/etc/passwd' },
		'clip.mp4',
		['dawn.mp3']
	])
		expect(parsePush({ media }), JSON.stringify(media)).toBeNull();
});

test('a maximal media push still fits the 1024-byte wall budget', () => {
	const id = (i: number) => `track-${i}-0123456789abcdef.mp3`; // 32 chars each
	const push = parsePush({
		place: 'himalayas',
		weather: 'towering',
		clock: 21.5,
		gains: { street: 2, building: 2, far: 2, haze: 1, glow: 1, volume: 1 },
		media: { audio: Array.from({ length: MAX_MEDIA_IDS }, (_, i) => id(i)), video: 'clip-0123456789abcdef.mp4' },
		mode: 'standby'
	})!;
	expect(JSON.stringify(push).length).toBeLessThan(MAX_PUSH_BYTES);
});

test('the wall flies, holds its blinds down, or stands by dark; nothing else', () => {
	expect(parsePush({})!.mode).toBeNull();
	expect(parsePush({ mode: 'blind' })!.mode).toBe('blind');
	expect(parsePush({ mode: 'standby' })!.mode).toBe('standby');
	expect(parsePush({ mode: 'party' })).toBeNull();
	expect(parsePush({ mode: 1 })).toBeNull();
	// A wall stored before modes existed still parses, as flying.
	expect(parsePush({ place: 'dubai', weather: null, clock: null, gains: NO_GAINS, media: NO_MEDIA })!.mode).toBeNull();
});
