/**
 * status.ts — the shape of GET /api/status, declared once.
 *
 * It was declared three times: the endpoint's `json({...})` literal, and an
 * `interface NetworkStatus` hand-copied into BOTH /admin and the operator
 * drawer. That is not a tidiness complaint. The /admin copy drifted to a shape
 * the endpoint never sent (`version`, `memory`, `network`), so
 * `status.memory.heapUsedMb` threw during component init, and a throw in init
 * renders an EMPTY BODY -- /admin served 200 OK with 19 characters in it, with
 * nothing in the console but a client-side error nobody was watching.
 *
 * Now the endpoint writes `satisfies KioskStatus` and both readers import this
 * type, so the same drift is a failed `svelte-check`, not a blank kiosk page.
 */
export interface KioskStatus {
	online: boolean;
	hostname: string;
	uptimeSec: number;
	freeMemBytes: number;
	totalMemBytes: number;
	lanIps: { name: string; address: string; family: string }[];
	primaryLanIp: string;
	port: number;
	/**
	 * Frames per second, as measured by THIS pane's browser.
	 *
	 * Optional because the server cannot observe a frame: it is populated only
	 * once the tab has POSTed to `/api/internal/vitals`, and goes away again if
	 * the tab stops reporting. `health-check.sh` scrapes this field and
	 * `HeartbeatSample.fps` carries it to the cockpit.
	 *
	 * Absent is NOT zero. Zero means a stalled renderer, which is a real and
	 * alarming measurement; absent means nobody has said yet.
	 */
	fps?: number;
	frameTimeMs?: number;
}

/**
 * Fetch it, or throw with a message worth showing.
 *
 * Both callers used to roll their own. The drawer's version checked `res.ok`,
 * aborted on teardown and surfaced the failure; /admin's did none of that, so a
 * 500 became `undefined` fields rendered as blanks -- an unreachable Pi looked
 * like a reachable one with nothing to say. One implementation, the careful one.
 */
export async function fetchStatus(signal?: AbortSignal): Promise<KioskStatus> {
	const res = await fetch('/api/status', { signal });
	if (!res.ok) throw new Error(`/api/status returned ${res.status}`);
	return (await res.json()) as KioskStatus;
}

/**
 * One device's line in the fleet rollup, as `GET /api/fleet/heartbeat` serves
 * it. Mirrors `HeartbeatSample` minus `lastError`, which that route withholds
 * from unauthenticated readers.
 *
 * Declared here rather than imported from `lib/server/heartbeat.ts` because a
 * browser bundle must not pull in a module that reads `process.env` and holds
 * the fleet's Map. `status.ts` is already the shared shape file for exactly
 * this reason — see the note above `KioskStatus`, where three hand-copied
 * declarations of one response drifted and rendered /admin blank.
 */
export interface FleetDevice {
	deviceId: string;
	role: string;
	groupId: string;
	fps?: number;
	tempC?: number;
	uptimeSec: number;
	crashCount: number;
	commit?: string;
	mode?: string;
	throttledRaw?: number;
	thermalAction?: 'ok' | 'shed';
	clockSynced?: boolean;
	receivedAtMs: number;
}

/**
 * Two missed 60 s beats plus slack. A device is offline when it has stopped
 * reporting, not when one POST lost a race with a 60 s timer.
 *
 * Declared HERE, and imported by `lib/server/heartbeat.ts`, rather than the
 * other way around: this file is client-reachable and that one reads
 * `process.env` and holds the fleet's Map. Server may import the shared root;
 * the root may not import `server/`.
 *
 * It used to be a second copy of the number carrying the comment "must match
 * ONLINE_WINDOW_MS server-side" -- in the one file whose own header explains
 * that three hand-copied declarations of one response drifted and rendered
 * /admin blank. A comment is not a constraint.
 */
export const FLEET_ONLINE_WINDOW_MS = 150_000;

/** What a fleet rollup needs from a device row, and nothing more. */
export interface FleetRollupInput {
	receivedAtMs: number;
	fps?: number;
	tempC?: number;
	thermalAction?: 'ok' | 'shed';
	clockSynced?: boolean;
}

export interface FleetRollup {
	total: number;
	online: number;
	offline: number;
	/** Null when no ONLINE device reported an fps — not 0, which reads as stalled. */
	avgFps: number | null;
	/** How many contributed to `avgFps`, so a dashboard can say so. */
	fpsSampled: number;
	maxTempC: number | null;
	/** Devices actively shedding GPU work. */
	shedding: number;
	/**
	 * Devices reporting an UNSYNCED clock. Not the same as "did not report": a
	 * device that cannot tell is excluded, because an unknown must not render
	 * as a fault.
	 */
	clockUnsynced: number;
}

/**
 * Roll a fleet up, ONCE.
 *
 * Counts (`total`/`online`/`offline`) span every device ever seen. Every HEALTH
 * metric spans only the devices still reporting, and that distinction is the
 * bug this function exists to end: the rollup used to apply the freshness
 * window to `online` and to nothing else, so a Pi that was unplugged while hot
 * kept contributing its last temperature to `maxTempC` and its last decision to
 * `shedding` — forever. `AdminFleetHealth.svelte` warns at `maxTempC >= 78` and
 * at `shedding > 0`, so a dead pane lit a permanent red light about a machine
 * that was switched off. Same mistake as `readThermalState` believing a frozen
 * file: a reading nobody is taking is not a reading.
 *
 * Declared here because it was written twice — `summarize()` server-side and a
 * `$derived.by` in /admin — and this file exists for exactly that: three
 * hand-copied declarations of one response drifted and rendered /admin blank.
 * The duplication was deliberate and well-argued (one fetch, so the table and
 * the headline cannot disagree); it is the ALGORITHM that must not be copied,
 * not the call site.
 */
export function rollUpFleet(
	devices: readonly FleetRollupInput[],
	nowMs: number = Date.now()
): FleetRollup {
	const live = devices.filter((d) => nowMs - d.receivedAtMs < FLEET_ONLINE_WINDOW_MS);
	const fps = live.map((d) => d.fps).filter((v): v is number => v !== undefined);
	const temps = live.map((d) => d.tempC).filter((v): v is number => v !== undefined);

	return {
		total: devices.length,
		online: live.length,
		offline: devices.length - live.length,
		avgFps: fps.length ? fps.reduce((a, b) => a + b, 0) / fps.length : null,
		fpsSampled: fps.length,
		maxTempC: temps.length ? Math.max(...temps) : null,
		shedding: live.filter((d) => d.thermalAction === 'shed').length,
		clockUnsynced: live.filter((d) => d.clockSynced === false).length
	};
}

export async function fetchFleet(signal?: AbortSignal): Promise<FleetDevice[]> {
	const res = await fetch('/api/fleet/heartbeat', { signal });
	if (!res.ok) throw new Error(`/api/fleet/heartbeat returned ${res.status}`);
	return (await res.json()) as FleetDevice[];
}

/**
 * Where this device's admin cockpit can be reached from another machine.
 *
 * Lives here, not in the component that shows it, because `lib/display/` is
 * forbidden from naming a protocol at all — `regressions.test.ts` scans it for
 * a bare `http://` and fails. That rule exists because a renderer building its
 * own URL is how `world/cesium/imagery.ts` came to hardcode two tile hosts
 * while the template scan reported the invariant as held.
 *
 * The rule is about tile providers and this is a LAN self-address, so the
 * letter of it is stricter than the spirit. Following it anyway is still right:
 * the check is deliberately blunt precisely so nobody has to adjudicate that
 * distinction under pressure, and this is where the IP and port already live.
 *
 * Null when the device has no LAN address. `primaryLanIp` falls back to the
 * string `localhost`, which is a real answer meaning "nothing to scan" — and a
 * QR pointing at localhost would send a phone to itself.
 */
export function adminUrl(status: KioskStatus): string | null {
	if (!status.primaryLanIp || status.primaryLanIp === 'localhost') return null;
	return `http://${status.primaryLanIp}:${status.port}/admin`;
}
