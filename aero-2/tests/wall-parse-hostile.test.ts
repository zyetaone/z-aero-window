import { describe, it, expect } from 'vitest';
import { WEATHERS } from '#lib/wall.js';
import {
	MAX_ID_CHARS,
	MAX_WALL_BYTES,
	MAX_MEDIA_URL_CHARS,
	MAX_PLAYLIST_ENTRIES,
	DISPLAY_MODES,
	parseWallState,
	WALL_KEYS
} from '#lib/wall.js';

/**
 * The wall push is the ONE input that changes every pane at once.
 *
 * A malformed accept here does not break one window, it breaks the whole
 * installation simultaneously, and `pushWall` persists it — so a bad snapshot
 * survives the reboot that would otherwise clear it. That asymmetry is why this
 * probes the parser adversarially rather than testing the happy path again.
 */
const good = () => ({
	placeId: 'denver',
	presetId: 'default',
	weather: 'clear',
	clockOffsetH: 0,
	displayMode: 'flight',
	blindOpen: true,
	rotate: true,
	mediaUrls: [] as unknown[],
	audioUrls: [] as unknown[]
});

describe('parseWallState refuses what it should', () => {
	it('accepts a well-formed snapshot', () => {
		expect(parseWallState(good())).not.toBeNull();
	});

	it('refuses a missing key rather than defaulting it', () => {
		for (const k of WALL_KEYS) {
			const b: Record<string, unknown> = good();
			delete b[k];
			expect(parseWallState(b), `a push missing ${k} was accepted`).toBeNull();
		}
	});

	it('refuses prototype pollution attempts', () => {
		const evil = JSON.parse('{"__proto__":{"polluted":true}}');
		parseWallState({ ...good(), ...evil });
		expect(
			({} as Record<string, unknown>).polluted,
			'Object.prototype was polluted by a wall push'
		).toBeUndefined();
	});

	it('refuses non-finite and out-of-range clock offsets', () => {
		for (const v of [NaN, Infinity, -Infinity, 13, -13, 1e9]) {
			expect(parseWallState({ ...good(), clockOffsetH: v }), `clock ${v} accepted`).toBeNull();
		}
	});

	it('refuses a weather or mode it does not know', () => {
		expect(parseWallState({ ...good(), weather: 'apocalypse' })).toBeNull();
		expect(parseWallState({ ...good(), displayMode: 'rootshell' })).toBeNull();
	});

	it('refuses non-boolean booleans, including truthy strings', () => {
		for (const v of ['true', 1, 0, null, {}]) {
			expect(
				parseWallState({ ...good(), blindOpen: v }),
				`blindOpen ${JSON.stringify(v)}`
			).toBeNull();
			expect(parseWallState({ ...good(), rotate: v }), `rotate ${JSON.stringify(v)}`).toBeNull();
		}
	});

	it('refuses a javascript: or data: media URL', () => {
		for (const u of [
			'javascript:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'vbscript:msgbox'
		]) {
			expect(parseWallState({ ...good(), mediaUrls: [u] }), `${u} accepted`).toBeNull();
		}
	});

	it('refuses a non-array or non-string media list', () => {
		expect(parseWallState({ ...good(), mediaUrls: 'not-an-array' })).toBeNull();
		expect(parseWallState({ ...good(), mediaUrls: [123] })).toBeNull();
		expect(parseWallState({ ...good(), mediaUrls: [null] })).toBeNull();
	});

	it('does not carry extra keys through into the stored snapshot', () => {
		const out = parseWallState({ ...good(), evil: 'payload', __proto__: {} });
		expect(out).not.toBeNull();
		expect(Object.keys(out!).sort()).toEqual([...WALL_KEYS].sort());
	});
});

/**
 * The schema and the transport have to agree, and nothing used to make them.
 *
 * `MAX_WALL_BYTES` was tuned by hand against the fields that existed the day it
 * was written, with 254 bytes to spare. Adding `audioUrls` doubled the URL
 * budget and made a snapshot the schema ACCEPTS one the transport rejects with
 * a 413 -- a push an operator can compose in the admin UI and never see land.
 *
 * So this builds the largest snapshot the schema admits, from the schema's own
 * exported bounds rather than from copied numbers, and asserts it fits. A
 * thirteenth list, a longer URL cap or a raised entry count now fails HERE,
 * which is a test failure, instead of in the field, which is a silent one.
 */
describe('the schema fits through the transport', () => {
	const longest = (xs: readonly string[]) => xs.reduce((a, b) => (b.length > a.length ? b : a));
	const longestUrl = '/' + 'a'.repeat(MAX_MEDIA_URL_CHARS - 1);
	const longestId = 'a'.repeat(MAX_ID_CHARS);

	const worstCase = () => ({
		placeId: longestId,
		presetId: longestId,
		// Longest legal value of each enum, taken from the enum, not guessed.
		weather: longest(WEATHERS),
		clockOffsetH: -11.999999999999998,
		displayMode: longest(DISPLAY_MODES),
		blindOpen: true,
		rotate: true,
		mediaUrls: Array.from({ length: MAX_PLAYLIST_ENTRIES }, () => longestUrl),
		audioUrls: Array.from({ length: MAX_PLAYLIST_ENTRIES }, () => longestUrl)
	});

	it('the biggest schema-legal snapshot is under the byte cap', () => {
		const bytes = new TextEncoder().encode(JSON.stringify(worstCase())).length;
		expect(
			bytes,
			`worst-case snapshot is ${bytes} bytes against a ${MAX_WALL_BYTES}-byte cap`
		).toBeLessThan(MAX_WALL_BYTES);
	});

	it('and that worst case is in fact schema-legal', () => {
		// Guards the test itself: if this stops parsing, the bytes above are
		// measuring something the server would have refused anyway.
		expect(parseWallState(worstCase())).not.toBeNull();
	});
});
