/**
 * Reading the thermal state health-check.sh leaves on disk.
 *
 * The action is ALWAYS re-derived here from the temperature and the flags, and
 * the file's own `action` is used only as the previous value the hysteresis
 * band needs. A file that says `shed` after the Pi has cooled cannot pin the
 * wall in performance mode, and hand-editing the JSON cannot force it either.
 *
 * That guarantee holds only while the file KEEPS BEING WRITTEN, which is why
 * the age check below is not a nicety. If `health-check.sh` stops, the file
 * freezes -- its `action` AND its `tempC` -- so re-deriving reproduces the last
 * decision forever. A Pi that stalled at `shed`/75 deg then re-derives `shed`
 * from a `prev` of `shed` and a temperature above the clear threshold, on every
 * request, for as long as the process lives. The Pi cools; the file does not
 * say so; the wall stays degraded. A stale reading is not a reading.
 */

import { existsSync, readFileSync } from 'node:fs';

import { FLEET_ONLINE_WINDOW_MS } from '#lib/status.js';
import {
	decodeThrottleFlags,
	parseThrottledRaw,
	thermalAction,
	type ThermalAction,
	type ThermalState
} from '#lib/throttle.js';

export const DEFAULT_THERMAL_PATH = '/run/aero/thermal.json';

/**
 * `state: null` with a reason, never a bare 204.
 *
 * A 204 forces the client to guess whether thermal is fine or simply absent,
 * and those render identically — the same silence `x-aero-dataset: missing`
 * exists to prevent on the tile side. A dev host and a Pi whose health-check
 * died must not look the same.
 */
export type ThermalRead =
	{ state: ThermalState; reason?: undefined } | { state: null; reason: string };

/**
 * How old a reading may be before it stops counting as one.
 *
 * `health-check.sh` writes this file and POSTs the heartbeat in the same run,
 * on the same 60 s cadence, so "this device has stopped reporting" is one
 * question with one answer -- and the fleet already defines it. Reusing that
 * constant is what keeps the dashboard's idea of a dead Pi and the display's
 * idea of a dead thermal feed from drifting apart.
 */
export const THERMAL_STALE_MS = FLEET_ONLINE_WINDOW_MS;

export function readThermalState(
	path = DEFAULT_THERMAL_PATH,
	nowMs: number = Date.now()
): ThermalRead {
	if (!existsSync(path)) {
		return { state: null, reason: `no thermal state at ${path} — health-check.sh has not run` };
	}

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
	} catch {
		return { state: null, reason: `thermal state at ${path} is unreadable or not JSON` };
	}

	const tempC = num(parsed.tempC);
	const throttledRaw = parseThrottledRaw(parsed.throttledRaw);
	const flags = decodeThrottleFlags(throttledRaw);
	const prev: ThermalAction = parsed.action === 'shed' ? 'shed' : 'ok';
	const updatedAtMs = num(parsed.updatedAtMs);

	/**
	 * Absent, not stale-but-usable. `thermal-poll` resolves every `state: null`
	 * to 'ok', which is the documented asymmetry -- "a device with no thermal
	 * reporting is the NORMAL case off-Pi" -- and is the right answer here too:
	 * a dead health-check is not evidence the Pi is hot.
	 *
	 * A file with no usable `updatedAtMs` reads as age `nowMs`, i.e. stale. It
	 * cannot claim to be fresh without saying when it was written.
	 */
	const ageMs = nowMs - updatedAtMs;
	if (ageMs > THERMAL_STALE_MS) {
		return {
			state: null,
			reason: `thermal state at ${path} is ${Math.round(ageMs / 1000)}s old — health-check.sh has stopped writing it`
		};
	}

	return {
		state: {
			tempC,
			throttledRaw,
			action: thermalAction(tempC, flags, prev),
			updatedAtMs,
			flags
		}
	};
}

function num(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
