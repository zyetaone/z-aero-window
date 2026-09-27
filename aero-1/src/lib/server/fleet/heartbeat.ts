/**
 * Fleet heartbeat — in-memory ring buffer for per-device metrics.
 *
 * Each Pi POSTs to /api/fleet/heartbeat every 60s (via deploy/pi/health-check.sh).
 * The admin server stores the last ~8 hours of samples per device (500 entries
 * × 60s = 30000s ≈ 8.3h). The /admin/fleet/health page reads this and renders
 * a live tile per device with the most recent metrics + a sparkline.
 *
 * Persistence: every sample is also appended as one JSON line to a JSONL log
 * (default /var/log/aero-heartbeats.jsonl on Linux; override with
 * AERO_HEARTBEAT_LOG; disabled elsewhere unless the env var is set). On boot
 * the ring buffers are re-seeded from the tail of that log, so a collector
 * restart no longer wipes "what happened overnight". The log is rotated by
 * deploy/pi/aero-updater.logrotate. Writes are best-effort: a full/read-only
 * disk must never break heartbeat recording.
 *
 * Contract — heartbeat POST body (matches deploy/pi/health-check.sh):
 *   {
 *     deviceId:    string    // hostname
 *     role:        string    // 'solo' | 'left' | 'center' | 'right'
 *     groupId:     string
 *     fps:         number    // avg FPS as reported by local /api/fleet?health
 *     temp:        number    // CPU °C
 *     uptime:      number    // seconds since boot
 *     crashCount:  number    // aero-kiosk.service NRestarts
 *     mode?:       string    // display mode from /api/status (flight|video|screensaver)
 *     throttledRaw?: number  // vcgencmd get_throttled bitfield
 *     thermalAction?: 'ok'|'shed'  // load-shed policy (see throttle.ts)
 *   }
 *
 * This is a pure state module — no DOM, no fetch. It's imported by the
 * +server.ts route, not by a component — plain module-level Map/Array, no
 * runes, for server-side hot-reload friendliness.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import type { DeviceStats, FleetSummary } from '$lib/fleet/protocol';
import { ONLINE_THRESHOLD_MS } from '$lib/fleet/protocol';
import {
	decodeThrottleFlags,
	parseThrottledRaw,
	type ThermalAction,
	type ThrottleFlags,
} from '$lib/fleet/throttle';

export interface HeartbeatSample {
	/** Wall-clock ms when the admin received the sample. */
	receivedAt: number;
	deviceId: string;
	role: string;
	groupId: string;
	fps: number;
	temp: number;
	uptime: number;
	crashCount: number;
	/** Build commit the device is running (optional — older health-check.sh). */
	commit?: string;
	/** Last aero-app journal error line (optional; length-capped sender-side). */
	lastError?: string;
	/** Kiosk display path from browser /api/status (optional — older health-check.sh). */
	mode?: string;
	/** Apply-ack: last admin push the kiosk browser applied (optional — older builds). */
	lastAppliedCommandId?: string;
	/** vcgencmd get_throttled bitfield (0 if non-Pi / old health-check). */
	throttledRaw?: number;
	/** Decoded flags for UI — always derived from throttledRaw when present. */
	throttle?: ThrottleFlags;
	/** Load-shed policy last computed on the device (ok | shed). */
	thermalAction?: ThermalAction;
	/**
	 * receivedAt minus the device's reported clock, ms (optional — older
	 * health-check.sh). Includes network latency (tens of ms on the LAN);
	 * what matters is the SPREAD across panes, see FleetSummary.maxClockSkewMs.
	 */
	clockSkewMs?: number;
}

/** How many samples we keep per device. 500 × 60s ≈ 8.3h. */
const MAX_SAMPLES_PER_DEVICE = 500;

/**
 * Hostname-shaped allowlist used by both POST (recordHeartbeat) and the
 * route's GET ?deviceId= query validation. Single source of truth — the
 * GET path must never accept an id that POST would have rejected, or the
 * dashboard could look up entries that the store never wrote.
 */
export const DEVICE_ID_PATTERN = /^[a-zA-Z0-9._-]{1,64}$/;

/**
 * Per-device ring buffer. Oldest samples drop off once we hit
 * MAX_SAMPLES_PER_DEVICE. We use a plain array rather than a circular
 * buffer because 500 elements is tiny and the dashboard wants
 * chronological order anyway.
 */
const samples = new Map<string, HeartbeatSample[]>();

// ─── JSONL persistence ──────────────────────────────────────────────────────
// Env override wins; default on the Pi is /var/log (rotated by
// deploy/pi/aero-updater.logrotate). Off by default on non-Linux so dev hosts
// and tests never touch the filesystem unless they opt in.
const LOG_PATH =
	process.env.AERO_HEARTBEAT_LOG ??
	(process.platform === 'linux' ? '/var/log/aero-heartbeats.jsonl' : null);

function appendToLog(sample: HeartbeatSample): void {
	if (!LOG_PATH) return;
	try {
		appendFileSync(LOG_PATH, JSON.stringify(sample) + '\n');
	} catch (e) {
		// Best-effort: a full or read-only disk must never break recording.
		console.warn('[heartbeat] log append failed:', (e as Error).message);
	}
}

/** Re-seed ring buffers from the log tail on boot (survives collector restarts). */
function loadFromLog(): void {
	if (!LOG_PATH) return;
	try {
		const stat = readFileSync(LOG_PATH); // whole file; logrotate caps it at 1M
		const lines = stat.toString('utf8').trim().split('\n');
		// Only the tail can matter — at most MAX_SAMPLES_PER_DEVICE per device.
		for (const line of lines.slice(-MAX_SAMPLES_PER_DEVICE * 8)) {
			try {
				const s = JSON.parse(line) as HeartbeatSample;
				if (!s || typeof s.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(s.deviceId)) continue;
				const buf = samples.get(s.deviceId) ?? [];
				buf.push(s);
				if (buf.length > MAX_SAMPLES_PER_DEVICE) buf.splice(0, buf.length - MAX_SAMPLES_PER_DEVICE);
				samples.set(s.deviceId, buf);
			} catch { /* skip corrupt line */ }
		}
	} catch { /* no log yet — first boot */ }
}
loadFromLog();

/**
 * Record an incoming heartbeat.
 *
 * Rejects (returns false) if the payload is malformed — we never trust
 * Pi-supplied data blindly since this endpoint is network-facing inside
 * the corridor LAN. Valid samples are appended and the oldest one is
 * evicted if we're at the cap.
 */
export function recordHeartbeat(input: unknown): HeartbeatSample | null {
	if (!input || typeof input !== 'object') return null;
	const o = input as Record<string, unknown>;

	const deviceId = typeof o.deviceId === 'string' ? o.deviceId : null;
	// DEVICE_ID_PATTERN closes log-injection in console.warn paths elsewhere
	// in fleet/, and rules out shell metacharacters if a deviceId ever ends
	// up in a script invocation.
	if (!deviceId || !DEVICE_ID_PATTERN.test(deviceId)) return null;

	// Numeric fields — default to 0 on missing/bad input so a partially-failed
	// health-check still gets recorded (better: "device is up but reporting 0"
	// than "no signal at all").
	const numeric = (key: string): number => {
		const v = o[key];
		return typeof v === 'number' && Number.isFinite(v) ? v : 0;
	};

	const sample: HeartbeatSample = {
		receivedAt: Date.now(),
		deviceId,
		role: typeof o.role === 'string' ? o.role : 'solo',
		groupId: typeof o.groupId === 'string' ? o.groupId : 'default',
		fps: numeric('fps'),
		temp: numeric('temp'),
		uptime: numeric('uptime'),
		crashCount: numeric('crashCount'),
		// Optional debug fields — length-capped here too (network-facing).
		commit: typeof o.commit === 'string' ? o.commit.slice(0, 40) : undefined,
		lastError: typeof o.lastError === 'string' && o.lastError.length > 0
			? o.lastError.slice(0, 240)
			: undefined,
		// Display mode from kiosk /api/status (flight | video | screensaver).
		mode: typeof o.mode === 'string' && /^[a-z]{1,24}$/.test(o.mode)
			? o.mode
			: undefined,
		// Apply-ack id — length-capped like commit/lastError (network-facing).
		lastAppliedCommandId: typeof o.lastAppliedCommandId === 'string' && o.lastAppliedCommandId.length > 0
			? o.lastAppliedCommandId.slice(0, 64)
			: undefined,
		thermalAction: o.thermalAction === 'shed' || o.thermalAction === 'ok'
			? o.thermalAction
			: undefined,
	};
	if (typeof o.clockMs === 'number' && Number.isFinite(o.clockMs)) {
		sample.clockSkewMs = Math.round(sample.receivedAt - o.clockMs);
	}

	// Thermal / power throttle (optional — older health-check omits the field).
	if ('throttledRaw' in o) {
		sample.throttledRaw = parseThrottledRaw(o.throttledRaw);
		sample.throttle = decodeThrottleFlags(sample.throttledRaw);
	}

	const buf = samples.get(deviceId) ?? [];
	buf.push(sample);
	// Drop oldest when at cap. slice() is O(n) but 500 is tiny so this is fine.
	if (buf.length > MAX_SAMPLES_PER_DEVICE) {
		buf.splice(0, buf.length - MAX_SAMPLES_PER_DEVICE);
	}
	samples.set(deviceId, buf);
	appendToLog(sample);
	return sample;
}

/**
 * Get the full sample history for a device. Returned array is a copy so
 * callers can sort / filter without mutating the ring buffer.
 */
export function historyForDevice(deviceId: string): HeartbeatSample[] {
	const buf = samples.get(deviceId);
	return buf ? buf.slice() : [];
}

/**
 * Snapshot of the latest heartbeat from every device we've ever heard from.
 * Used by the dashboard to render one tile per device.
 */
export function latestAll(): HeartbeatSample[] {
	const out: HeartbeatSample[] = [];
	for (const buf of samples.values()) {
		if (buf.length > 0) out.push(buf[buf.length - 1]);
	}
	return out;
}

/**
 * Is the device considered online? We say yes if we've seen a heartbeat in
 * the last 3 intervals (= 3 × 60s = 3 min). Any longer and the Pi is
 * probably crashed or offline.
 */

function isOnline(sample: HeartbeatSample, now: number = Date.now()): boolean {
	return now - sample.receivedAt < ONLINE_THRESHOLD_MS;
}

/**
 * Nearest-rank percentile over an ASCENDING-sorted array.
 *
 * Nearest-rank (not linear interpolation) on purpose: it always returns a
 * value the device actually reported, so "fpsP05 = 27" means some real sample
 * read 27 — not an average of two neighbours that never occurred. For a perf
 * gate that decides whether hardware holds framerate, a real observation is
 * the more defensible number.
 */
function percentile(sortedAsc: number[], p: number): number {
	if (sortedAsc.length === 0) return 0;
	const rank = Math.ceil((p / 100) * sortedAsc.length);
	return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
}

/**
 * Per-device rollup over the retained window — the P8 backfill.
 *
 * This is what turns "the fleet has run overlay-ON for weeks" into a number
 * you can hold against the P8 thresholds. See DeviceStats in fleet/protocol
 * for why the reported tail is p05 rather than p95.
 *
 * Samples with fps === 0 are KEPT, not filtered: a zero means the local
 * /api/status scrape failed or the renderer stalled, and dropping those would
 * turn the exact failure P8 is looking for into a gap in the data.
 */
export function statsAll(): DeviceStats[] {
	const out: DeviceStats[] = [];
	for (const buf of samples.values()) {
		if (buf.length === 0) continue;
		const last = buf[buf.length - 1];
		const fps = buf.map((s) => s.fps).sort((a, b) => a - b);
		out.push({
			deviceId: last.deviceId,
			role: last.role,
			groupId: last.groupId,
			samples: buf.length,
			windowMs: last.receivedAt - buf[0].receivedAt,
			fpsP50: Math.round(percentile(fps, 50) * 10) / 10,
			fpsP05: Math.round(percentile(fps, 5) * 10) / 10,
			fpsMin: Math.round(fps[0] * 10) / 10,
			maxTempC: buf.reduce((max, s) => Math.max(max, s.temp), 0),
			crashCount: buf.reduce((max, s) => Math.max(max, s.crashCount), 0),
			commit: last.commit,
			mode: last.mode,
			lastAppliedCommandId: last.lastAppliedCommandId,
			throttledRaw: last.throttledRaw,
			thermalAction: last.thermalAction,
		});
	}
	return out;
}

/**
 * Compute basic rollups across the whole fleet — the dashboard header uses
 * these. Online count, average FPS across online devices, hottest CPU, etc.
 */
export function summarize(now: number = Date.now()): FleetSummary {
	const all = latestAll();
	const online = all.filter((s) => isOnline(s, now));
	const offline = all.length - online.length;
	const avgFps =
		online.length > 0 ? online.reduce((sum, s) => sum + s.fps, 0) / online.length : 0;
	const maxTempC = online.reduce((max, s) => Math.max(max, s.temp), 0);
	const totalCrashes = all.reduce((sum, s) => sum + s.crashCount, 0);
	const shedding = online.filter((s) => s.thermalAction === 'shed').length;
	const throttledLive = online.filter((s) => s.throttle?.livePressure).length;
	// Largest pairwise clock difference among online panes. Latency cancels
	// to first order (same LAN, same admin), so this is the wall's real skew.
	const skews = online.map((s) => s.clockSkewMs).filter((v): v is number => v !== undefined);
	const maxClockSkewMs = skews.length >= 2 ? Math.max(...skews) - Math.min(...skews) : undefined;
	return {
		total: all.length,
		online: online.length,
		offline,
		avgFps: Math.round(avgFps * 10) / 10,
		maxTempC,
		totalCrashes,
		shedding,
		throttledLive,
		maxClockSkewMs,
	};
}

