import { describe, it, expect, beforeEach } from 'vitest';
import {
	clearHeartbeats,
	latestAll,
	ONLINE_WINDOW_MS,
	recordHeartbeat,
	summarize
} from '#lib/server/heartbeat.js';
import { GET, POST } from '../src/routes/api/fleet/heartbeat/+server.js';

/** Exactly what deploy/pi/health-check.sh puts on the wire. */
const wire = (over: Record<string, unknown> = {}) => ({
	deviceId: 'aero-1',
	role: 'left',
	groupId: 'wall',
	fps: 60,
	temp: 52.1,
	uptime: 8000,
	crashCount: 0,
	commit: 'abc1234',
	lastError: '',
	mode: 'flight',
	throttledRaw: 0,
	thermalAction: 'ok',
	...over
});

beforeEach(() => clearHeartbeats());

describe('recordHeartbeat', () => {
	it('accepts the health-check payload verbatim', () => {
		const s = recordHeartbeat(wire(), 1000);
		expect(s).toMatchObject({
			deviceId: 'aero-1',
			role: 'left',
			fps: 60,
			tempC: 52.1,
			uptimeSec: 8000,
			thermalAction: 'ok',
			receivedAtMs: 1000
		});
	});

	it('refuses anything without a usable deviceId', () => {
		for (const bad of [
			null,
			'string',
			42,
			{},
			wire({ deviceId: '' }),
			wire({ deviceId: '../etc' }),
			wire({ deviceId: 'a'.repeat(80) })
		]) {
			expect(recordHeartbeat(bad), JSON.stringify(bad)?.slice(0, 40)).toBeNull();
		}
	});

	it('keeps only the latest sample per device', () => {
		recordHeartbeat(wire({ uptime: 1 }), 1);
		recordHeartbeat(wire({ uptime: 2 }), 2);
		recordHeartbeat(wire({ deviceId: 'aero-2' }), 3);
		expect(latestAll()).toHaveLength(2);
		expect(latestAll().find((s) => s.deviceId === 'aero-1')?.uptimeSec).toBe(2);
	});

	it('never serves lastError to a GET client', () => {
		recordHeartbeat(wire({ lastError: 'EGL failed to initialise' }), 1);
		expect(latestAll()[0]).not.toHaveProperty('lastError');
	});

	it('caps lastError rather than storing an unbounded journal line', () => {
		const s = recordHeartbeat(wire({ lastError: 'x'.repeat(5000) }), 1);
		expect(s!.lastError!.length).toBe(200);
	});

	it('drops junk numerics instead of storing NaN', () => {
		const s = recordHeartbeat(wire({ fps: 'fast', temp: null, uptime: -5, crashCount: 'many' }), 1);
		expect(s).toMatchObject({ fps: undefined, tempC: undefined, uptimeSec: 0, crashCount: 0 });
	});
});

describe('summarize', () => {
	/**
	 * The trap this exists for. health-check.sh sends fps 0 when it cannot read
	 * one, and aero-2's /api/status reports none — so an unreported fps must be
	 * absent, not 0, or the whole wall reads as a stalled renderer forever.
	 * A real 0 still has to mean stalled.
	 */
	it('excludes unreported fps from the average and says how many it sampled', () => {
		recordHeartbeat(wire({ deviceId: 'a', fps: 60 }), 1);
		recordHeartbeat(wire({ deviceId: 'b', fps: undefined }), 1);
		const s = summarize(1);
		expect(s).toMatchObject({ total: 2, avgFps: 60, fpsSampled: 1 });
	});

	it('reports a genuinely stalled renderer as 0, not as unreported', () => {
		recordHeartbeat(wire({ deviceId: 'a', fps: 0 }), 1);
		expect(summarize(1)).toMatchObject({ avgFps: 0, fpsSampled: 1 });
	});

	it('reports null rather than 0 when nothing sampled fps', () => {
		recordHeartbeat(wire({ fps: undefined, temp: undefined }), 1);
		expect(summarize(1)).toMatchObject({ avgFps: null, fpsSampled: 0, maxTempC: null });
	});

	/**
	 * `online` was the ONLY field the freshness window reached. `maxTempC`,
	 * `shedding`, `clockUnsynced` and `avgFps` were all rolled up over every
	 * device ever seen — so a Pi unplugged while hot kept contributing its last
	 * temperature and its last shed decision for as long as the process lived.
	 * `AdminFleetHealth.svelte` warns at `maxTempC >= 78` and at `shedding > 0`,
	 * so a dead pane lit a permanent red light about a machine that was off.
	 *
	 * Every existing test here rolls up at a `nowMs` where nothing is offline,
	 * which is why all nineteen of them passed before and after the fix.
	 */
	it('drops a dead pane out of the health metrics, not just the count', () => {
		recordHeartbeat({ deviceId: 'left', fps: 30, temp: 82, thermalAction: 'shed', clockSynced: false }, 0);
		recordHeartbeat({ deviceId: 'right', fps: 60, temp: 44, thermalAction: 'ok', clockSynced: true }, 0);

		const fresh = summarize(1);
		expect(fresh).toMatchObject({ online: 2, maxTempC: 82, shedding: 1, clockUnsynced: 1, avgFps: 45 });

		// `left` goes quiet; `right` keeps beating.
		recordHeartbeat({ deviceId: 'right', fps: 60, temp: 44, thermalAction: 'ok', clockSynced: true }, ONLINE_WINDOW_MS);
		const after = summarize(ONLINE_WINDOW_MS + 1);

		expect(after.total, 'the device is still known').toBe(2);
		expect(after.online).toBe(1);
		expect(after.offline).toBe(1);
		expect(after.maxTempC, 'a switched-off Pi is not 82 degrees').toBe(44);
		expect(after.shedding, 'it cannot still be shedding — it is not running').toBe(0);
		expect(after.clockUnsynced, 'an absent clock is not a drifting clock').toBe(0);
		expect(after.avgFps, 'its last fps must not drag the live average').toBe(60);
		expect(after.fpsSampled).toBe(1);
	});

	it('counts a device offline once it stops reporting', () => {
		recordHeartbeat(wire(), 0);
		expect(summarize(ONLINE_WINDOW_MS - 1)).toMatchObject({ online: 1, offline: 0 });
		expect(summarize(ONLINE_WINDOW_MS + 1)).toMatchObject({ online: 0, offline: 1 });
	});

	it('takes the hottest pane, not the average', () => {
		recordHeartbeat(wire({ deviceId: 'a', temp: 50 }), 1);
		recordHeartbeat(wire({ deviceId: 'b', temp: 79 }), 1);
		expect(summarize(1).maxTempC).toBe(79);
	});
});

describe('the heartbeat route', () => {
	const post = (auth: string | undefined, body: unknown, bytes = JSON.stringify(body)) =>
		POST({
			request: new Request('http://pane/api/fleet/heartbeat', {
				method: 'POST',
				body: bytes,
				...(auth ? { headers: { authorization: auth } } : {})
			})
		} as Parameters<typeof POST>[0]);

	it('fails closed with 503 when AERO_FLEET_TOKEN is unset', async () => {
		delete process.env.AERO_FLEET_TOKEN;
		expect((await post('Bearer x', wire())).status).toBe(503);
	});

	it('records a good payload and rejects a malformed one', async () => {
		process.env.AERO_FLEET_TOKEN = 'fleet';
		try {
			expect((await post('Bearer fleet', wire())).status).toBe(200);
			expect(latestAll()).toHaveLength(1);
			expect((await post('Bearer fleet', { nope: true })).status).toBe(400);
			expect((await post('Bearer wrong', wire())).status).toBe(401);
		} finally {
			delete process.env.AERO_FLEET_TOKEN;
		}
	});

	it('caps the body before parsing it', async () => {
		process.env.AERO_FLEET_TOKEN = 'fleet';
		try {
			const huge = JSON.stringify(wire({ lastError: 'x'.repeat(20_000) }));
			expect((await post('Bearer fleet', null, huge)).status).toBe(413);
		} finally {
			delete process.env.AERO_FLEET_TOKEN;
		}
	});

	it('serves the rollup unauthenticated, and the summary on request', async () => {
		recordHeartbeat(wire(), Date.now());
		const call = (q: string) =>
			GET({
				request: new Request('http://pane/api/fleet/heartbeat'),
				url: new URL(`http://pane/api/fleet/heartbeat${q}`)
			} as Parameters<typeof GET>[0]);

		expect(await (await call('')).json()).toHaveLength(1);
		expect(await (await call('?summary')).json()).toMatchObject({ total: 1, online: 1 });
	});
});

describe('clock sync is telemetry too', () => {
	beforeEach(() => clearHeartbeats());

	/**
	 * The one field here that is about CORRECTNESS rather than health. The whole
	 * panorama is a function of the wall clock — pose, sun, the director's
	 * rotation slot and a wall push's `applyAtWallSec` are each derived
	 * independently per pane, which only agrees while the clocks do. An unsynced
	 * Pi flies a different part of the orbit and lights a different time of day
	 * while every other check reports green.
	 *
	 * `display-dim-schedule.sh` already waited for NTP before trusting the hour,
	 * for the strictly smaller reason of dimming at the wrong time. The
	 * heartbeat did not carry it at all.
	 */
	it('records an explicit synced / unsynced flag', () => {
		expect(recordHeartbeat({ deviceId: 'a', clockSynced: 1 })?.clockSynced).toBe(true);
		expect(recordHeartbeat({ deviceId: 'b', clockSynced: 0 })?.clockSynced).toBe(false);
		expect(recordHeartbeat({ deviceId: 'c', clockSynced: true })?.clockSynced).toBe(true);
		expect(recordHeartbeat({ deviceId: 'd', clockSynced: false })?.clockSynced).toBe(false);
	});

	/**
	 * -1 is health-check.sh's "cannot tell" — an image with no `timedatectl`.
	 * That must stay undefined rather than collapsing to false, because a
	 * dashboard rendering "unknown" as "DRIFT" sends someone to a site visit for
	 * a device that is fine.
	 */
	it('an unknowable clock is undefined, never false', () => {
		expect(recordHeartbeat({ deviceId: 'e', clockSynced: -1 })?.clockSynced).toBeUndefined();
		expect(recordHeartbeat({ deviceId: 'f' })?.clockSynced).toBeUndefined();
		expect(recordHeartbeat({ deviceId: 'g', clockSynced: 'yes' })?.clockSynced).toBeUndefined();
	});

	it('counts only devices that positively reported drift', () => {
		recordHeartbeat({ deviceId: 'ok1', clockSynced: 1 });
		recordHeartbeat({ deviceId: 'bad', clockSynced: 0 });
		recordHeartbeat({ deviceId: 'unknown' });
		recordHeartbeat({ deviceId: 'cannot-tell', clockSynced: -1 });
		expect(summarize().clockUnsynced, 'an unknown clock was counted as drift').toBe(1);
	});

	it('counts panes actively shedding GPU work', () => {
		recordHeartbeat({ deviceId: 'cool', thermalAction: 'ok' });
		recordHeartbeat({ deviceId: 'hot', thermalAction: 'shed', tempC: 82 });
		recordHeartbeat({ deviceId: 'quiet' });
		const s = summarize();
		expect(s.shedding).toBe(1);
		expect(s.maxTempC).toBe(82);
	});
});
