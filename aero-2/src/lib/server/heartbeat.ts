/**
 * Fleet heartbeat store.
 *
 * Every Pi POSTs here each 60 s from deploy/pi/health-check.sh. The wire shape
 * is fixed by that script, so this module validates rather than designs it.
 *
 * ONE SAMPLE PER DEVICE, not a ring buffer. v1 retained 500 samples per device
 * plus optional JSONL spooling, to serve a per-device history view and a
 * p50/p05 perf gate — neither of which aero-2 has a reader for. What the wall
 * actually needs is "are all three panes alive and how hot are they", which the
 * latest sample answers. Memory is O(devices), which on a wall is three.
 *
 * The store is per-server and in memory: it dies with the process and is not
 * shared between panes. That is deliberate and matches the founding premise —
 * a Pi posts to itself by default, so its own admin page works with no fleet
 * anywhere. Point AERO_ADMIN_URL at a hub to aggregate.
 */

/** Hostnames. Anchored, because it reaches a Map key and a JSON response. */
export const DEVICE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

/**
 * Two missed beats plus slack, defined in the shared root so the browser and
 * this module cannot disagree about who is online. Re-exported under the name
 * this module's readers already use.
 */
export { FLEET_ONLINE_WINDOW_MS as ONLINE_WINDOW_MS } from '#lib/status.js';
import { FLEET_ONLINE_WINDOW_MS as ONLINE_WINDOW_MS } from '#lib/status.js';

export interface HeartbeatSample {
	deviceId: string;
	role: string;
	groupId: string;
	/**
	 * Optional, and the reason is the whole trap. health-check.sh scrapes fps out
	 * of GET /api/status and falls back to 0, meaning "the app is down". aero-2's
	 * /api/status reports no fps at all, so a faithful port would record 0 for
	 * every healthy pane forever and summarize() would read the wall as stalled.
	 * Undefined means not reported and is excluded from the average; 0 stays a
	 * real measurement of a stalled renderer.
	 */
	fps?: number;
	tempC?: number;
	uptimeSec: number;
	crashCount: number;
	commit?: string;
	mode?: string;
	throttledRaw?: number;
	thermalAction?: 'ok' | 'shed';
	/**
	 * Whether this device's clock is NTP-synced. Undefined means the device did
	 * not say — an older health-check.sh, or an image with no `timedatectl`.
	 *
	 * This is the one telemetry field that is about CORRECTNESS rather than
	 * health. The whole panorama is a function of the wall clock: pose, sun,
	 * the director's rotation slot and a wall push's `applyAtWallSec` are each
	 * derived independently per pane, which only agrees while the clocks do. An
	 * unsynced Pi flies a different part of the orbit and lights a different
	 * time of day while every other check on this page reports green.
	 */
	clockSynced?: boolean;
	/** One journal line of WHY. Never served to an unauthenticated reader. */
	lastError?: string;
	receivedAtMs: number;
}

export interface FleetSummary {
	total: number;
	online: number;
	offline: number;
	/** Null when no device reported an fps at all — not 0, which reads as stalled. */
	avgFps: number | null;
	/** How many of `total` contributed to avgFps, so a dashboard can say so. */
	fpsSampled: number;
	maxTempC: number | null;
	/** Devices actively shedding GPU work. */
	shedding: number;
	/**
	 * Devices that reported an UNSYNCED clock. Not the same as "did not report":
	 * a device that cannot tell is excluded, because an unknown must not be
	 * rendered as a fault.
	 */
	clockUnsynced: number;
}

const latest = new Map<string, HeartbeatSample>();

/** Validates and stores. Returns null for anything it will not record. */
export function recordHeartbeat(body: unknown, nowMs: number = Date.now()): HeartbeatSample | null {
	if (typeof body !== 'object' || body === null) return null;
	const b = body as Record<string, unknown>;

	const deviceId = typeof b.deviceId === 'string' ? b.deviceId : '';
	if (!DEVICE_ID_PATTERN.test(deviceId)) return null;

	const sample: HeartbeatSample = {
		deviceId,
		role: str(b.role) ?? 'unknown',
		groupId: str(b.groupId) ?? 'default',
		fps: nonNegative(b.fps),
		tempC: finite(b.tempC ?? b.temp),
		uptimeSec: nonNegative(b.uptime ?? b.uptimeSec) ?? 0,
		crashCount: nonNegative(b.crashCount) ?? 0,
		commit: str(b.commit),
		mode: str(b.mode),
		throttledRaw: nonNegative(b.throttledRaw),
		thermalAction:
			b.thermalAction === 'shed' ? 'shed' : b.thermalAction === 'ok' ? 'ok' : undefined,
		// health-check.sh sends 1 / 0 / -1, where -1 is "cannot tell" (no
		// timedatectl). Only an explicit 1 or 0 becomes a boolean; -1 and a
		// missing field both stay undefined, so "unknown" never renders as
		// "not synced".
		clockSynced:
			b.clockSynced === 1 || b.clockSynced === true
				? true
				: b.clockSynced === 0 || b.clockSynced === false
					? false
					: undefined,
		// Capped: it is a journal line from an untrusted-ish source that ends up
		// in a JSON response and, on a hub, in a Map that lives for weeks.
		lastError: str(b.lastError)?.slice(0, 200),
		receivedAtMs: nowMs
	};

	latest.set(deviceId, sample);
	return sample;
}

/**
 * What an unauthenticated reader gets. `lastError` is a raw journal line —
 * useful on the device, not something to hand to every client on a venue LAN.
 */
export function latestAll(): Omit<HeartbeatSample, 'lastError'>[] {
	return [...latest.values()].map(({ lastError: _drop, ...pub }) => pub);
}

export function summarize(nowMs: number = Date.now()): FleetSummary {
	const all = [...latest.values()];
	const online = all.filter((s) => nowMs - s.receivedAtMs < ONLINE_WINDOW_MS).length;

	const fps = all.map((s) => s.fps).filter((v): v is number => v !== undefined);
	const temps = all.map((s) => s.tempC).filter((v): v is number => v !== undefined);

	return {
		total: all.length,
		online,
		offline: all.length - online,
		avgFps: fps.length ? fps.reduce((a, b) => a + b, 0) / fps.length : null,
		fpsSampled: fps.length,
		maxTempC: temps.length ? Math.max(...temps) : null,
		shedding: all.filter((s) => s.thermalAction === 'shed').length,
		clockUnsynced: all.filter((s) => s.clockSynced === false).length
	};
}

/** Test seam. The store is module state, so a suite needs a way back to empty. */
export function clearHeartbeats(): void {
	latest.clear();
}

function str(v: unknown): string | undefined {
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function finite(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function nonNegative(v: unknown): number | undefined {
	const n = finite(v);
	return n !== undefined && n >= 0 ? n : undefined;
}
