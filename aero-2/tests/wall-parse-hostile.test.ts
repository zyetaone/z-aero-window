import { describe, it, expect } from 'vitest';
import { parseWallState, WALL_KEYS } from '#lib/wall.js';

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
	mediaUrls: [] as unknown[]
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
