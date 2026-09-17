import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseWallState, WALL_KEYS, type WallState } from '#lib/wall.js';
import { LEAD_SEC, pushWall, readWall } from '#lib/server/wall-store.js';
import { GET, POST } from '../src/routes/api/wall/+server.js';

const good: WallState = {
	placeId: 'denver',
	presetId: 'golden-hour',
	weather: 'cloudy',
	clockOffsetH: -2.5,
	displayMode: 'flight',
	blindOpen: false,
	rotate: false,
	mediaUrls: [],
	audioUrls: []
};

const dirs: string[] = [];
const wallPath = () => {
	const d = mkdtempSync(join(tmpdir(), 'aero-wall-'));
	dirs.push(d);
	return join(d, 'wall.json');
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	delete process.env.AERO_WALL_PATH;
	delete process.env.AERO_ADMIN_TOKEN;
});

describe('parseWallState', () => {
	it('accepts a complete, legal snapshot', () => {
		expect(parseWallState({ ...good })).toEqual(good);
	});

	/**
	 * A push is a whole snapshot. Accepting a subset would need a merge rule,
	 * and a merge rule is the CRDT ADR-007 rejected growing back one field at a
	 * time.
	 */
	it('refuses a partial push, whichever key is missing', () => {
		for (const k of WALL_KEYS) {
			const partial: Record<string, unknown> = { ...good };
			delete partial[k];
			expect(parseWallState(partial), `missing ${k}`).toBeNull();
		}
	});

	it('refuses values outside the closed sets', () => {
		expect(parseWallState({ ...good, weather: 'sleet' })).toBeNull();
		expect(parseWallState({ ...good, displayMode: 'kiosk' })).toBeNull();
		expect(parseWallState({ ...good, blindOpen: 'yes' })).toBeNull();
		expect(parseWallState({ ...good, rotate: 1 })).toBeNull();
	});

	it('clamps nothing — it refuses an out-of-range clock offset', () => {
		expect(parseWallState({ ...good, clockOffsetH: 13 })).toBeNull();
		expect(parseWallState({ ...good, clockOffsetH: Number.NaN })).toBeNull();
		expect(parseWallState({ ...good, clockOffsetH: 12 })?.clockOffsetH).toBe(12);
	});

	/**
	 * placeId reaches a catalog lookup and a JSON response, so it is bounded and
	 * identifier-shaped even though the server does not own the catalog.
	 */
	it('refuses ids that are not identifier-shaped, and allows the empty one', () => {
		for (const bad of ['../etc', 'a b', 'A', 'x'.repeat(65), 42, null]) {
			expect(parseWallState({ ...good, placeId: bad }), String(bad)).toBeNull();
		}
		expect(parseWallState({ ...good, presetId: '' })?.presetId).toBe('');
	});

	it('refuses anything that is not an object', () => {
		for (const bad of [null, 'x', 42, []]) expect(parseWallState(bad)).toBeNull();
	});
});

describe('the wall store', () => {
	it('reports version 0 when nothing has ever been pushed', () => {
		expect(readWall(wallPath())).toMatchObject({ version: 0, applyAtWallSec: 0 });
	});

	it('increments the version and schedules a lead time', () => {
		const p = wallPath();
		const first = pushWall(good, 1000, p);
		expect(first).toMatchObject({ version: 1, applyAtWallSec: 1000 + LEAD_SEC });

		const second = pushWall({ ...good, weather: 'rain' }, 1001, p);
		expect(second.version).toBe(2);
		expect(readWall(p).state.weather).toBe('rain');
	});

	/**
	 * Ordering is an integer the writer owns, never a clock. A pane whose NTP
	 * has not settled cannot reorder pushes, so no sanity floor is needed.
	 */
	it('orders by version even when the clock goes backwards', () => {
		const p = wallPath();
		pushWall(good, 5000, p);
		expect(pushWall(good, 1, p).version).toBe(2);
	});

	it('survives a corrupt file rather than wedging the wall', () => {
		const p = wallPath();
		writeFileSync(p, '{ not json');
		expect(readWall(p)).toMatchObject({ version: 0 });
		expect(pushWall(good, 1000, p).version).toBe(1);
	});

	it('writes through a temp file, so a reader never sees half a snapshot', () => {
		const p = wallPath();
		pushWall(good, 1000, p);
		expect(JSON.parse(readFileSync(p, 'utf8'))).toMatchObject({ version: 1 });
	});
});

describe('/api/wall', () => {
	const get = (headers: Record<string, string> = {}) =>
		GET({
			request: { headers: new Headers(headers) } as Request,
			url: new URL('http://pane/api/wall')
		} as Parameters<typeof GET>[0]);

	const post = (addr: string, body: unknown, headers: Record<string, string> = {}) =>
		POST({
			request: new Request('http://pane/api/wall', {
				method: 'POST',
				body: JSON.stringify(body),
				headers
			}),
			getClientAddress: () => addr
		} as Parameters<typeof POST>[0]);

	it('answers a poll with an ETag and a 304 on the next one', async () => {
		process.env.AERO_WALL_PATH = wallPath();
		await post('127.0.0.1', good);

		const first = await get();
		const etag = first.headers.get('etag');
		expect(etag).toBe('W/"1"');

		expect((await get({ 'if-none-match': etag! })).status).toBe(304);
	});

	/**
	 * The pane's own drawer runs in a browser ON the Pi, so it reaches this over
	 * loopback with no credential — which is what lets a fresh device work
	 * unconfigured. Anything else is a machine on the venue LAN.
	 */
	it('accepts a push over loopback with no token', async () => {
		process.env.AERO_WALL_PATH = wallPath();
		expect((await post('127.0.0.1', good)).status).toBe(200);
	});

	it('fails closed for a LAN caller when no admin token is set', async () => {
		process.env.AERO_WALL_PATH = wallPath();
		expect((await post('192.168.1.9', good)).status).toBe(503);
	});

	it('accepts a LAN caller holding the admin token, and refuses a wrong one', async () => {
		process.env.AERO_WALL_PATH = wallPath();
		process.env.AERO_ADMIN_TOKEN = 'admin';
		expect((await post('192.168.1.9', good, { authorization: 'Bearer admin' })).status).toBe(200);
		expect((await post('192.168.1.9', good, { authorization: 'Bearer nope' })).status).toBe(401);
	});

	it('rejects a malformed push with 400 and does not bump the version', async () => {
		const p = wallPath();
		process.env.AERO_WALL_PATH = p;
		await post('127.0.0.1', good);
		expect((await post('127.0.0.1', { weather: 'rain' })).status).toBe(400);
		expect(readWall(p).version).toBe(1);
	});

	/**
	 * A client proposing its own version or apply time is how a merge rule
	 * sneaks back in. Both are ignored: the server assigns them.
	 */
	it('ignores a client-supplied version and applyAtWallSec', async () => {
		process.env.AERO_WALL_PATH = wallPath();
		const res = await post('127.0.0.1', { ...good, version: 99, applyAtWallSec: 1 });
		const body = await res.json();
		expect(body.version).toBe(1);
		expect(body.applyAtWallSec).toBeGreaterThan(1);
	});
});

describe('mediaUrls — the mode and its content travel together', () => {
	/**
	 * The wall could push `displayMode: 'video'` while the only writers of the
	 * playlist fields were `?media=` URL params parsed at boot — so the switch
	 * put "No media specified" on every pane. The list rides in the snapshot
	 * now, and the parser owns its bounds.
	 */
	it('accepts a legal list', () => {
		expect(
			parseWallState({ ...good, mediaUrls: ['/cabin.mp4', 'https://cdn.x/y.webm'] })
		).not.toBeNull();
	});

	it('rejects a push missing the field — a whole snapshot means whole', () => {
		const { mediaUrls: _drop, ...partial } = good;
		expect(parseWallState(partial)).toBeNull();
	});

	/**
	 * `javascript:` in a `<video src>` is inert in modern browsers, but "inert
	 * in modern browsers" is not a contract worth shipping on a kiosk that runs
	 * one browser build for years. Rejected loudly rather than filtered
	 * quietly: a push with one bad URL should fail at the admin's screen, not
	 * land minus a track nobody noticed was dropped.
	 */
	it('rejects non-path, non-http urls', () => {
		for (const bad of [
			['javascript:alert(1)'],
			['data:text/html,x'],
			['relative.mp4'],
			['//protocol-relative.example/x.mp4'],
			[''],
			['/ok.mp4', 'ftp://x/y']
		]) {
			expect(parseWallState({ ...good, mediaUrls: bad }), JSON.stringify(bad)).toBeNull();
		}
	});

	it('bounds the list and each entry', () => {
		expect(parseWallState({ ...good, mediaUrls: Array(13).fill('/a.mp4') })).toBeNull();
		expect(parseWallState({ ...good, mediaUrls: ['/' + 'a'.repeat(300)] })).toBeNull();
		expect(parseWallState({ ...good, mediaUrls: 'not-an-array' })).toBeNull();
	});
});
