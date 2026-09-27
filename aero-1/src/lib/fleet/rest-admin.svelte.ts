/**
 * REST-based admin store. Replaces the WS-based AdminStore.
 *
 * Talks to each discovered device directly — no central broker. Device
 * list comes from /api/devices (mDNS peers + self) on the serving Pi.
 * Status polls each device's /api/status every 5 s. Admin writes go out
 * as:
 *   POST /api/command  { type: 'set_scene' | 'set_mode' | 'set_config', … }
 *   PATCH /api/config  { path, value, timestamp, sourceId }
 *
 * /api/command carries the legacy flat DisplayConfig shape so the device
 * browser applies via model.applyPatch — preserves v1 semantics. PATCH
 * /api/config with timestamp+sourceId engages the CRDT merge for
 * multi-admin concurrent writes.
 */

import type {
	DisplayConfig,
	DeviceInfo,
} from '$lib/fleet/protocol';
import type { LocationId, WeatherType, DisplayMode } from '$lib/types';
import { urlFor, STATUS_INTERVAL_MS, PEER_REFRESH_INTERVAL_MS } from '$lib/fleet/protocol';
import { peerJsonHeaders } from '$lib/http/peer-token';

type ConnectionState = 'connecting' | 'connected' | 'degraded' | 'disconnected';

interface FleetHealth {
	total: number;
	online: number;
	offline: number;
	avgFps: number;
	lowFpsCount: number;
}

interface HealthAlert {
	level: 'error' | 'warning';
	device: string;
	message: string;
}

interface DiscoveredPeer {
	deviceId: string;
	host: string;
	port: number;
	self?: boolean;
}

function adminSourceId(): string {
	if (typeof localStorage === 'undefined') return 'admin';
	const key = 'aero-admin-session-id';
	let id = localStorage.getItem(key);
	if (!id) {
		id = `admin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
		localStorage.setItem(key, id);
	}
	return id;
}

/**
 * Correlation id for one admin fan-out (apply-ack). The same id goes into
 * every per-device payload of the push; each kiosk records it on apply and
 * echoes it back in its /api/status heartbeat as `lastAppliedCommandId`.
 * Math.random is fine here — this is an admin action, not a shared-scene
 * path, so determinism across Pis is not required (contrast invariant #4).
 */
export function newCommandId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class RestAdminStore {
	// $state.raw on the array references: every update is a full
	// reassignment (this.devices = this.devices.map(...)) — fine-grained
	// proxy reactivity buys nothing and costs traversal overhead.
	devices = $state.raw<DeviceInfo[]>([]);
	fleetHealth = $state.raw<FleetHealth>({ total: 0, online: 0, offline: 0, avgFps: 0, lowFpsCount: 0 });
	alerts = $state.raw<HealthAlert[]>([]);

	#peers: DiscoveredPeer[] = [];
	#statusInterval: ReturnType<typeof setInterval> | null = null;
	#discoveryInterval: ReturnType<typeof setInterval> | null = null;
	#destroyed = false;
	#sourceId: string;
	#connection = $state<ConnectionState>('connecting');

	// ── Apply-ack tracking ────────────────────────────────────────────────────
	// A 200 from /api/command or /api/config means "published to the SSE bus",
	// NOT "applied by the kiosk" — a crashed kiosk browser still publishes
	// green. trackCommand() arms one commandId per fan-out; each kiosk records
	// it on apply and echoes it in its 5 s heartbeat, and ackProgress counts
	// how many targets have echoed. Converges within ~5–10 s of the push.
	#ackCommandId = $state<string | null>(null);
	#ackTargetIds = $state.raw<readonly string[]>([]);

	/**
	 * Arm ack-tracking for a fan-out. Call BEFORE pushing so the admin UI can
	 * show a "waiting for ack" state while heartbeats catch up.
	 */
	trackCommand(commandId: string, targets: readonly string[]): void {
		this.#ackCommandId = commandId;
		this.#ackTargetIds = targets;
	}

	/** Live ack progress for the most recent trackCommand(); null before any push. */
	ackProgress = $derived.by((): { applied: number; total: number } | null => {
		const id = this.#ackCommandId;
		if (!id) return null;
		const wanted = new Set(this.#ackTargetIds);
		const applied = this.devices.filter(
			(d) => wanted.has(d.deviceId) && d.lastAppliedCommandId === id,
		).length;
		return { applied, total: this.#ackTargetIds.length };
	});

	get connectionState(): ConnectionState { return this.#connection; }
	get isDestroyed(): boolean { return this.#destroyed; }
	/** Discovered peer addresses. Read by peer-sync's $effect. */
	get peers(): ReadonlyArray<DiscoveredPeer> { return this.#peers; }

	constructor() {
		this.#sourceId = adminSourceId();
		this.refresh();
		// Two cadences:
		//   status poll  — every 5 s, per-peer /api/status GET
		//   discovery    — every 30 s, re-read /api/devices so new Pis appear
		//                  without a manual page refresh. Matches mDNS
		//                  ANNOUNCE_INTERVAL_MS — no point polling faster.
		this.#statusInterval = setInterval(() => this.#pollStatus(), STATUS_INTERVAL_MS);
		this.#discoveryInterval = setInterval(() => this.refresh(), PEER_REFRESH_INTERVAL_MS);
	}

	destroy(): void {
		this.#destroyed = true;
		if (this.#statusInterval) clearInterval(this.#statusInterval);
		if (this.#discoveryInterval) clearInterval(this.#discoveryInterval);
	}

	/** Initial discover + status fetch. Also exposed so admin UI can manually refresh. */
	async refresh(): Promise<void> {
		if (this.#destroyed) return;
		this.#connection = 'connecting';
		try {
			const res = await fetch('/api/devices', { cache: 'no-store' });
			if (!res.ok) throw new Error(`devices ${res.status}`);
			const body = await res.json() as { devices: DiscoveredPeer[] };
			this.#peers = body.devices;
			// Seed device rows with placeholder status; #pollStatus will fill.
			//
			// The seed must CARRY FORWARD what we already knew about each device.
			// This map is rebuilt wholesale every PEER_REFRESH_INTERVAL_MS (30 s),
			// and it used to reset lastSeen to 0 for every row on each pass — so a
			// device that had been online and then dropped lost its last real
			// heartbeat time within 30 s and the grid rendered
			// "Last: 497115h ago" (0 is epoch, not a timestamp). The sentinel 0 is
			// only truthful for a device we have NEVER heard from; it must not also
			// mean "we did hear from it, thirty seconds ago, and we threw that away".
			//
			// #pollStatus only overwrites lastSeen for peers whose /api/status
			// answered; on failure it returns {deviceId, online: false} and leaves
			// the field alone, which is what makes carrying it forward correct.
			const prevById = new Map(this.devices.map((d) => [d.deviceId, d] as const));
			this.devices = this.#peers.map((p) => {
				const prev = prevById.get(p.deviceId);
				return {
					deviceId: p.deviceId,
					hostname: p.host,
					currentMode: 'flight',
					currentLocation: 'dubai' as LocationId,
					fps: 0,
					uptime: 0,
					lastSeen: prev?.lastSeen ?? 0,
					online: prev?.online ?? false,
				};
			});
			await this.#pollStatus();
			this.#connection = this.devices.some((d) => d.online) ? 'connected' : 'degraded';
		} catch (e) {
			console.warn('[admin] refresh failed:', (e as Error).message);
			this.#connection = 'disconnected';
		}
	}

	/**
	 * Re-fetch status from known peers without wiping the device list.
	 * Used after set_mode / set_scene so Mode chips catch up quickly.
	 */
	async refreshStatus(): Promise<void> {
		if (this.#destroyed || this.#peers.length === 0) return;
		await this.#pollStatus();
	}

	async #pollStatus(): Promise<void> {
		if (this.#destroyed) return;
		const results = await Promise.all(
			this.#peers.map(async (peer): Promise<Partial<DeviceInfo> & { deviceId: string }> => {
				try {
					const res = await fetch(`${urlFor(peer)}/api/status`, {
						signal: AbortSignal.timeout(3000),
						cache: 'no-store',
					});
					if (!res.ok) return { deviceId: peer.deviceId, online: false };
					const status = await res.json();
					return {
						deviceId: peer.deviceId,
						hostname: status.hostname ?? peer.host,
						fps: status.fps ?? 0,
						currentMode: status.mode ?? 'flight',
						currentLocation: status.location ?? 'dubai',
						uptime: status.uptime ?? 0,
						lastSeen: status.lastSeen ?? Date.now(),
						online: status.online !== false,
						// Hardening fields — absent from older fielded builds (optional).
						commit: status.commit,
						errorCount: status.errorCount,
						lastErrors: status.lastErrors,
						// Apply-ack echo — drives ackProgress (absent on older builds).
						lastAppliedCommandId: status.lastAppliedCommandId,
					};
				} catch {
					return { deviceId: peer.deviceId, online: false };
				}
			}),
		);
		const byId = new Map(results.map((r) => [r.deviceId, r] as const));
		this.devices = this.devices.map((d) => ({ ...d, ...(byId.get(d.deviceId) ?? {}) }));
		this.#recomputeHealth();
	}

	#recomputeHealth(): void {
		const online = this.devices.filter((d) => d.online);
		const offline = this.devices.filter((d) => !d.online);
		const avgFps = online.length > 0
			? online.reduce((sum, d) => sum + d.fps, 0) / online.length
			: 0;
		const lowFps = online.filter((d) => d.fps > 0 && d.fps < 30);
		this.fleetHealth = {
			total: this.devices.length,
			online: online.length,
			offline: offline.length,
			avgFps: Math.round(avgFps * 10) / 10,
			lowFpsCount: lowFps.length,
		};
		this.alerts = [
			...offline.map((d) => ({ level: 'error' as const, device: d.deviceId, message: `${d.hostname || d.deviceId} is offline` })),
			...lowFps.map((d) => ({ level: 'warning' as const, device: d.deviceId, message: `${d.hostname || d.deviceId} low FPS: ${d.fps.toFixed(0)}` })),
		];
	}

	#peerFor(deviceId: string): DiscoveredPeer | undefined {
		return this.#peers.find((p) => p.deviceId === deviceId);
	}

	// Throws on non-2xx or network error so caller's fanOut() (which treats a
	// throw as failure) reports truthfully. Missing-peer-token is allowed to
	// resolve silently — `getPeerToken` falls back to the operator's session
	// and the failing-peer hint belongs in the per-peer handler, not here.
	async #postCommand(peer: DiscoveredPeer, body: { type: string; [k: string]: unknown }): Promise<void> {
		const res = await fetch(`${urlFor(peer)}/api/command`, {
			method: 'POST',
			headers: await peerJsonHeaders(peer.host),
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} from ${peer.deviceId}`);
		}
	}
	async pushScene(deviceId: string, location: LocationId, weather?: WeatherType, commandId?: string): Promise<void> {
		const peer = this.#peerFor(deviceId);
		if (!peer) return;
		await this.#postCommand(peer, { type: 'set_scene', location, weather, ...(commandId ? { commandId } : {}) });
	}

	async pushMode(deviceId: string, mode: DisplayMode, payload?: string, commandId?: string): Promise<void> {
		const peer = this.#peerFor(deviceId);
		if (!peer) return;
		// Wall-clock stamp for kiosk LWW vs local Escape / older SSE replay.
		await this.#postCommand(peer, { type: 'set_mode', mode, payload, decidedAtMs: Date.now(), ...(commandId ? { commandId } : {}) });
	}

	/**
	 * Push a scene-draft DTO — one-shot "command this device to be X." Ships
	 * as a `set_config` command; device applies through model.applyPatch (the
	 * DTO adapter that decomposes into typed setters + config PATCHes).
	 *
	 * This is for SCENE state (altitude, timeOfDay, weather, flightSpeed,
	 * syncToRealTime) — things that aren't in the config tree. Ambient config
	 * (clouds, haze, lights, quality) auto-propagates via peer-sync, so it
	 * does NOT belong in a scene push.
	 */
	async pushSceneFull(deviceId: string, scene: Partial<DisplayConfig>, commandId?: string): Promise<void> {
		const peer = this.#peerFor(deviceId);
		if (!peer) return;
		await this.#postCommand(peer, { type: 'set_config', patch: scene, ...(commandId ? { commandId } : {}) });
	}

	/**
	 * CRDT-aware per-path patch. Stamps {timestamp, sourceId} so concurrent
	 * admin writes on different fields both survive on each device.
	 *
	 * `commandId` is attached ONLY when the caller passes one. The ambient
	 * peer-sync loop drives this method on every slider tick; tagging those
	 * would churn each kiosk's lastAppliedCommandId constantly and drown the
	 * admin-push ack correlation in noise.
	 */
	async pushConfigPath(deviceId: string, path: string, value: unknown, commandId?: string): Promise<void> {
		const peer = this.#peerFor(deviceId);
		if (!peer) return;
		const res = await fetch(`${urlFor(peer)}/api/config`, {
			method: 'PATCH',
			headers: await peerJsonHeaders(peer.host),
			body: JSON.stringify({
				path,
				value,
				timestamp: Date.now(),
				sourceId: this.#sourceId,
				...(commandId ? { commandId } : {}),
			}),
		});
		if (!res.ok) {
			throw new Error(`HTTP ${res.status} from ${peer.deviceId}`);
		}
	}
	/**
	 * Trigger the OTA updater on one device NOW, instead of waiting up to 15 min
	 * for its timer. Returns a result rather than console.warn-ing into the void
	 * like the fire-and-forget command helpers above: the two likely failures are
	 * operator-actionable and indistinguishable from "nothing happened" —
	 * 503 means AERO_ADMIN_TOKEN is unset on THAT Pi, a network error means it's
	 * unreachable. The caller surfaces both.
	 *
	 * A success here only means the update STARTED. The device will drop offline
	 * while it rebuilds and restarts; the real confirmation is its commit chip
	 * changing on the next status poll.
	 */
	async triggerUpdate(deviceId: string): Promise<{ ok: boolean; detail?: string }> {
		const peer = this.#peerFor(deviceId);
		if (!peer) return { ok: false, detail: 'device not discovered' };
		try {
			const res = await fetch(`${urlFor(peer)}/api/update`, {
				method: 'POST',
				headers: await peerJsonHeaders(peer.host),
			});
			if (res.ok) return { ok: true };
			return {
				ok: false,
				detail: res.status === 503 ? 'AERO_ADMIN_TOKEN unset on device' : `HTTP ${res.status}`,
			};
		} catch (e) {
			return { ok: false, detail: (e as Error).message };
		}
	}

	/** Update every discovered device. Staggered is unnecessary — each Pi's own
	 *  updater exits in ~2 s when `release` hasn't moved. */
	async broadcastUpdate(): Promise<Array<{ deviceId: string; ok: boolean; detail?: string }>> {
		return Promise.all(
			this.#peers.map(async (p) => ({ deviceId: p.deviceId, ...(await this.triggerUpdate(p.deviceId)) })),
		);
	}
}

