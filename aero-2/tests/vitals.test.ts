import { describe, it, expect, beforeEach } from 'vitest';
import { recordVitals, readVitals, resetVitals, VITALS_MAX_AGE_MS } from '#lib/server/vitals.js';
import { GET } from '../src/routes/api/status/+server.js';

/**
 * The wire that made fleet fps monitoring do something.
 *
 * `HeartbeatSample.fps` was declared, parsed, averaged by `summarize()` and
 * rendered by the cockpit — which showed an em-dash for every device, forever,
 * because `/api/status` never carried an fps and nothing else could produce
 * one. Built end to end except for the browser telling the server what it saw.
 */
beforeEach(() => resetVitals());

const status = async () =>
	(
		await (GET as unknown as (e: unknown) => Promise<Response>)({
			request: new Request('http://pane/api/status'),
			getClientAddress: () => '127.0.0.1'
		})
	).json();

describe('render vitals', () => {
	it('reports nothing before the tab has said anything', async () => {
		expect(readVitals()).toBeNull();
		expect(await status()).not.toHaveProperty('fps');
	});

	it('carries a reported reading through to /api/status', async () => {
		recordVitals(58, 17.2);
		expect(readVitals()).toEqual({ fps: 58, frameTimeMs: 17.2 });
		const s = await status();
		expect(s.fps).toBe(58);
		expect(s.frameTimeMs).toBe(17.2);
	});

	/**
	 * Zero is a MEASUREMENT — a stalled renderer — and must survive.
	 *
	 * The staleness rule and the zero rule pull in opposite directions and both
	 * matter: dropping a stale reading stops a dead pane looking healthy, and
	 * keeping a zero stops a stalled pane looking absent.
	 */
	it('keeps a reported zero, because that means stalled', async () => {
		recordVitals(0, 0);
		expect(readVitals()).toEqual({ fps: 0, frameTimeMs: 0 });
		expect((await status()).fps).toBe(0);
	});

	it('drops a reading once it goes stale', () => {
		const t = 1_770_000_000_000;
		recordVitals(60, 16.6, t);
		expect(readVitals(t + VITALS_MAX_AGE_MS - 1)).not.toBeNull();
		expect(
			readVitals(t + VITALS_MAX_AGE_MS + 1),
			'a pane that stopped reporting still looked healthy'
		).toBeNull();
	});

	it('refuses a nonsense reading rather than publishing it', () => {
		recordVitals(NaN, 16);
		expect(readVitals()).toBeNull();
		recordVitals(-5, 16);
		expect(readVitals()).toBeNull();
	});
});
