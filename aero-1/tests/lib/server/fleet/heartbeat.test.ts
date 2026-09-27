import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The store reads AERO_HEARTBEAT_LOG at import time, so each test stubs the
// env and re-imports fresh (vi.resetModules).
describe('heartbeat JSONL persistence', () => {
	let dir: string;
	let log: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'aero-hb-'));
		log = join(dir, 'hb.jsonl');
		vi.stubEnv('AERO_HEARTBEAT_LOG', log);
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	it('appends each recorded sample as one JSON line', async () => {
		const { recordHeartbeat } = await import('$lib/server/fleet/heartbeat');
		recordHeartbeat({ deviceId: 'pi-1', fps: 60, temp: 50, uptime: 100, crashCount: 0 });
		const lines = readFileSync(log, 'utf8').trim().split('\n');
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).deviceId).toBe('pi-1');
	});

	it('re-seeds ring buffers from the log tail on fresh import (survives restart)', async () => {
		let mod = await import('$lib/server/fleet/heartbeat');
		mod.recordHeartbeat({ deviceId: 'pi-2', fps: 55, temp: 51, uptime: 200, crashCount: 1 });
		vi.resetModules();
		mod = await import('$lib/server/fleet/heartbeat');
		const all = mod.latestAll();
		expect(all.some((s) => s.deviceId === 'pi-2' && s.fps === 55)).toBe(true);
	});

	it('never writes when the log path is disabled', async () => {
		vi.stubEnv('AERO_HEARTBEAT_LOG', '');
		vi.resetModules();
		const { recordHeartbeat } = await import('$lib/server/fleet/heartbeat');
		recordHeartbeat({ deviceId: 'pi-3', fps: 60, temp: 50, uptime: 10, crashCount: 0 });
		expect(existsSync(log)).toBe(false);
	});
});

/**
 * statsAll() is the P8 perf gate read off field data instead of a bench run,
 * so these pin the properties that decide a GO/NO-GO — above all that a
 * stalling device cannot be made to look healthy.
 */
describe('heartbeat statsAll — P8 rollup', () => {
	beforeEach(() => {
		vi.stubEnv('AERO_HEARTBEAT_LOG', '');
		vi.resetModules();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	async function seed(fpsSeries: number[], deviceId = 'pi-a') {
		const mod = await import('$lib/server/fleet/heartbeat');
		for (const fps of fpsSeries) {
			mod.recordHeartbeat({ deviceId, role: 'center', groupId: 'g', fps, temp: 60, uptime: 1, crashCount: 0 });
		}
		return mod;
	}

	it('reports the low tail, so a device that stalls cannot hide behind a good p95', async () => {
		// 90 healthy samples + 10 stalls. A p95 would read 60 and look fine;
		// p05 must expose the floor. This is the whole reason p05 is reported.
		const mod = await seed([...Array(90).fill(60), ...Array(10).fill(6)]);
		const [s] = mod.statsAll();
		expect(s.fpsP50).toBe(60);
		expect(s.fpsP05).toBe(6);
		expect(s.fpsMin).toBe(6);
	});

	it('keeps fps:0 samples — a failed scrape IS the signal P8 looks for', async () => {
		const mod = await seed([0, 0, 60, 60]);
		const [s] = mod.statsAll();
		expect(s.samples).toBe(4);
		expect(s.fpsMin).toBe(0);
	});

	it('returns an actually-observed value (nearest-rank, never an interpolated average)', async () => {
		const mod = await seed([10, 20, 30, 40]);
		const [s] = mod.statsAll();
		// Linear interpolation would yield 25 for p50 — a reading no device gave.
		expect([10, 20, 30, 40]).toContain(s.fpsP50);
	});

	it('carries peak temp and worst crash count across the window, not just the last sample', async () => {
		const mod = await import('$lib/server/fleet/heartbeat');
		mod.recordHeartbeat({ deviceId: 'pi-b', fps: 60, temp: 84, uptime: 1, crashCount: 7 });
		mod.recordHeartbeat({ deviceId: 'pi-b', fps: 60, temp: 55, uptime: 2, crashCount: 0 });
		const s = mod.statsAll().find((d) => d.deviceId === 'pi-b')!;
		expect(s.maxTempC).toBe(84);
		expect(s.crashCount).toBe(7);
	});

	it('is empty before any device has reported', async () => {
		const mod = await import('$lib/server/fleet/heartbeat');
		expect(mod.statsAll()).toEqual([]);
	});
});

describe('heartbeat clock skew', () => {
	beforeEach(() => {
		vi.stubEnv('AERO_HEARTBEAT_LOG', '');
		vi.resetModules();
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.useRealTimers();
	});

	it('records receivedAt minus the device clock when clockMs is reported', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_700_000_000_000);
		const { recordHeartbeat } = await import('$lib/server/fleet/heartbeat');
		const s = recordHeartbeat({ deviceId: 'pi-a', clockMs: 1_700_000_000_000 - 1500 });
		expect(s?.clockSkewMs).toBe(1500);
		const older = recordHeartbeat({ deviceId: 'pi-old' });
		expect(older?.clockSkewMs).toBeUndefined();
	});

	it('summarises the largest pairwise skew across online panes, undefined below two clocks', async () => {
		vi.useFakeTimers();
		const t = 1_700_000_000_000;
		vi.setSystemTime(t);
		const { recordHeartbeat, summarize } = await import('$lib/server/fleet/heartbeat');
		recordHeartbeat({ deviceId: 'left', clockMs: t - 100 });
		expect(summarize(t).maxClockSkewMs).toBeUndefined();
		recordHeartbeat({ deviceId: 'center', clockMs: t - 2600 });
		recordHeartbeat({ deviceId: 'right', clockMs: t + 400 });
		// skews: 100, 2600, -400 → spread 3000
		expect(summarize(t).maxClockSkewMs).toBe(3000);
	});
});

