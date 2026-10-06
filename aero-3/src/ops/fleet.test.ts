import { expect, test } from 'bun:test';
import { parseHeartbeat } from './fleet.ts';

test('a heartbeat is typed and capped, and junk is refused', () => {
	const beat = parseHeartbeat({ deviceId: 'aero-display-01', role: 'left', fps: 2.5, temp: 61, uptime: 900, crashCount: 1, commit: 'abc1234', lastError: 'x'.repeat(999), thermalAction: 'ok', clockMs: 1.79e12, extra: 'dropped' });
	expect(beat).toMatchObject({ deviceId: 'aero-display-01', role: 'left', fps: 2.5, commit: 'abc1234', clockMs: 1.79e12 });
	expect(beat!.lastError.length).toBe(200);
	expect(beat).not.toHaveProperty('extra');
	expect(parseHeartbeat({ deviceId: 'a', fps: 'fast', clockMs: Number.NaN })).toMatchObject({ fps: 0 });
	expect(parseHeartbeat({ deviceId: 'a', clockMs: Number.NaN })).not.toHaveProperty('clockMs');
	for (const junk of [null, 'beat', {}, { deviceId: '' }, { deviceId: '../etc' }, { deviceId: '<script>' }]) expect(parseHeartbeat(junk)).toBeNull();
});
