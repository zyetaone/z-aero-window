import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readThermalState, THERMAL_STALE_MS } from '#lib/server/thermal.js';
import { GET } from '../src/routes/api/internal/thermal/+server.js';

const dirs: string[] = [];
const withFile = (contents: string) => {
	const d = mkdtempSync(join(tmpdir(), 'aero-thermal-'));
	dirs.push(d);
	const p = join(d, 'thermal.json');
	writeFileSync(p, contents);
	return p;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('readThermalState', () => {
	/**
	 * A 204 makes "thermal is fine" and "nothing is reporting thermal" render
	 * identically. Both absence cases must carry a reason a human can act on.
	 */
	it('reports absence with a reason, not silence', () => {
		const missing = readThermalState('/nope/thermal.json');
		expect(missing.state).toBeNull();
		expect(missing.reason).toContain('/nope/thermal.json');

		const junk = readThermalState(withFile('not json at all'));
		expect(junk.state).toBeNull();
		expect(junk.reason).toContain('unreadable');
	});

	it('reads a well-formed file', () => {
		const r = readThermalState(
			withFile(JSON.stringify({ tempC: 45, throttledRaw: '0x0', action: 'ok', updatedAtMs: 1000 })),
			1000
		);
		expect(r.state).toMatchObject({ tempC: 45, action: 'ok', updatedAtMs: 1000 });
	});

	/**
	 * The file's own `action` is an input to hysteresis, never the answer. A
	 * stale or hand-edited 'shed' on a cold Pi must not pin the wall in
	 * performance mode forever.
	 */
	it('re-derives the action instead of trusting the file', () => {
		const cold = readThermalState(
			withFile(JSON.stringify({ tempC: 20, throttledRaw: 0, action: 'shed', updatedAtMs: 1000 })),
			1000
		);
		expect(cold.state?.action).toBe('ok');

		const hot = readThermalState(
			withFile(JSON.stringify({ tempC: 95, throttledRaw: 0, action: 'ok', updatedAtMs: 1000 })),
			1000
		);
		expect(hot.state?.action).toBe('shed');
	});

	it('defaults missing numbers rather than emitting NaN', () => {
		const r = readThermalState(withFile('{}'), 0);
		expect(r.state).toMatchObject({ tempC: 0, throttledRaw: 0, updatedAtMs: 0, action: 'ok' });
	});

	/**
	 * The test above proves the claim at 20 deg C -- the one temperature where
	 * the hysteresis band CANNOT latch, because 20 is below the clear threshold
	 * and re-deriving gives 'ok' whatever `prev` says. The claim it is meant to
	 * prove ("a stale 'shed' must not pin the wall forever") lives between the
	 * two thresholds, and there it was false.
	 *
	 * With a frozen file at 75 deg C and 'shed', every re-derivation feeds
	 * `prev: 'shed'` and a temperature above CLEAR back into the band and gets
	 * 'shed' out again, on every request, for as long as the process lives. The
	 * Pi cools; the file does not say so. That is not hysteresis doing its job,
	 * it is a dead sensor being believed.
	 */
	it('does not believe a frozen file that latched itself at shed', () => {
		const frozen = JSON.stringify({ tempC: 75, throttledRaw: 0, action: 'shed', updatedAtMs: 0 });

		const fresh = readThermalState(withFile(frozen), 0);
		expect(fresh.state?.action, 'a genuinely fresh 75C reading still sheds').toBe('shed');

		const stale = readThermalState(withFile(frozen), THERMAL_STALE_MS + 1);
		expect(stale.state, 'a stale one is not a reading at all').toBeNull();
		expect(stale.reason).toContain('stopped writing');
	});

	/**
	 * `updatedAtMs` was parsed, carried through the response and read by
	 * nothing. The field that prevents the bug was already on the wire.
	 */
	it('treats a reading with no timestamp as stale, not as fresh', () => {
		const r = readThermalState(
			withFile(JSON.stringify({ tempC: 95, throttledRaw: 0, action: 'shed' })),
			Date.now()
		);
		expect(r.state).toBeNull();
	});

	it('accepts a reading inside the window and rejects one just outside', () => {
		const at = 10_000_000;
		const file = withFile(JSON.stringify({ tempC: 45, throttledRaw: 0, action: 'ok', updatedAtMs: at }));
		expect(readThermalState(file, at + THERMAL_STALE_MS).state).not.toBeNull();
		expect(readThermalState(file, at + THERMAL_STALE_MS + 1).state).toBeNull();
	});
});

describe('GET /api/internal/thermal', () => {
	const call = (addr: string) => GET({ getClientAddress: () => addr } as Parameters<typeof GET>[0]);

	it('answers loopback in all three spellings', async () => {
		for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
			expect((await call(a)).status, a).toBe(200);
		}
	});

	it('refuses anything else with 403', async () => {
		const res = await call('192.168.1.9');
		expect(res.status).toBe(403);
	});
});
