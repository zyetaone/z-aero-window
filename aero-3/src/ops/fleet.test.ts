import { expect, test } from 'bun:test';
import { parseHeartbeat, rollUp, STALE_SEC } from './fleet.ts';

test('a heartbeat is typed and capped, and junk is refused', () => {
	const beat = parseHeartbeat({ deviceId: 'aero-display-01', role: 'left', fps: 2.5, temp: 61, uptime: 900, crashCount: 1, commit: 'abc1234', lastError: 'x'.repeat(999), thermalAction: 'ok', clockMs: 1.79e12, extra: 'dropped' });
	expect(beat).toMatchObject({ deviceId: 'aero-display-01', role: 'left', fps: 2.5, commit: 'abc1234', clockMs: 1.79e12 });
	expect(beat!.lastError.length).toBe(200);
	expect(beat).not.toHaveProperty('extra');
	expect(parseHeartbeat({ deviceId: 'a', fps: 'fast', clockMs: Number.NaN })).toMatchObject({ fps: 0 });
	expect(parseHeartbeat({ deviceId: 'a', clockMs: Number.NaN })).not.toHaveProperty('clockMs');
	for (const junk of [null, 'beat', {}, { deviceId: '' }, { deviceId: '../etc' }, { deviceId: '<script>' }]) expect(parseHeartbeat(junk)).toBeNull();
});

test('the wall summary counts live panes only', () => {
	const now = 1_760_000_000_000;
	const row = (id: string, agoSec: number, temp: number, fps: number, thermalAction = 'ok') =>
		({ deviceId: id, role: 'left', fps, temp, uptime: 0, crashCount: 0, commit: '', lastError: '', thermalAction, receivedAt: now - agoSec * 1000 }) as const;
	const sum = rollUp([row('a', 30, 61, 20), row('b', 90, 70, 10, 'shed'), row('dead', STALE_SEC + 60, 85, 0)], now);
	expect(sum).toEqual({ live: 2, total: 3, hottestC: 70, shedding: 1, avgFps: 15 });
	expect(rollUp([], now)).toEqual({ live: 0, total: 0, hottestC: null, shedding: 0, avgFps: null });
});
