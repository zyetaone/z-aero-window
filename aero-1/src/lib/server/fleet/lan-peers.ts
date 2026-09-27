/**
 * LAN peer registry + mDNS lifecycle.
 *
 * Six Pis per install share the same LAN. Each announces itself via mDNS
 * (`_aero-bundle._tcp.local`) every 30s; receivers keep the list in a
 * Map keyed by device id. `listPeers()` returns the live set minus any
 * entries stale beyond PEER_TTL_MS.
 *
 * `.server.ts` suffix prevents Vite from bundling into the client; all
 * mDNS / net work stays in the Node/Bun process.
 */

import mdns from 'multicast-dns';
import { PEER_REFRESH_INTERVAL_MS } from '$lib/fleet/protocol';
import { DEVICE_ID_PATTERN } from './heartbeat';

// ─── Configuration ──────────────────────────────────────────────────────────

const SERVICE_TYPE = '_aero-bundle._tcp.local';
/** Re-announce on the same cadence the browser-side clients poll /api/devices. */
const ANNOUNCE_INTERVAL_MS = PEER_REFRESH_INTERVAL_MS;
/** Peer announcement is considered stale after this many ms without a refresh. */
const PEER_TTL_MS = 90_000;
/**
 * Hard bound on the peer map. mDNS answers are untrusted LAN input — without
 * a cap a flood of bogus SRV records grows the map (and /api/devices) without
 * limit. 64 is ~10× the largest real install.
 */
const MAX_PEERS = 64;

/**
 * Pinned roster. `AERO_PEERS` is a comma-separated list of device ids; when
 * it is set, an mDNS announcement from any id NOT on it is dropped before it
 * reaches the peer map. Unset (the default for a fresh install) means
 * discovery is open, as it always was — the roster is the second lock,
 * the shape check + cap being the first. A wall with a fixed set of Pis
 * gains nothing from open discovery and loses the ability of any device
 * on the LAN to appear in /api/devices and receive admin commands.
 *
 * Read per call, not at import, so tests (and a systemd restart) see the
 * current environment.
 */
export function pinnedPeers(): ReadonlySet<string> | null {
	const raw = process.env.AERO_PEERS?.trim();
	if (!raw) return null;
	return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

/** Local service port — the admin-exposed `/api/bundle/:hash` endpoint. */
function servicePort(): number {
	return Number.parseInt(process.env.PORT ?? '3000', 10);
}

/**
 * Device hostname — used in mDNS answers and as this device's self-identity
 * in /api/devices. Falls back to `aero-unknown`.
 */
export function deviceHost(): string {
	return process.env.AERO_DEVICE_ID ?? process.env.HOSTNAME ?? 'aero-unknown';
}

// ─── Peer registry (in-memory, mDNS-populated) ──────────────────────────────

export interface Peer {
	deviceId: string;
	host: string;
	port: number;
	lastSeen: number;
}

const peers = new Map<string, Peer>();

/** Purge peers we haven't heard from in PEER_TTL_MS. */
function gcPeers(): void {
	const cutoff = Date.now() - PEER_TTL_MS;
	for (const [id, p] of peers) {
		if (p.lastSeen < cutoff) peers.delete(id);
	}
}

/** Snapshot of current live peers — exposed for admin UI / tests. */
export function listPeers(): readonly Peer[] {
	gcPeers();
	return Array.from(peers.values());
}

// ─── mDNS wiring ────────────────────────────────────────────────────────────

let mdnsServer: ReturnType<typeof mdns> | null = null;
let announceTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Broadcast our service record on the LAN. Called on startup and then every
 * ANNOUNCE_INTERVAL_MS. Other Pis pick this up and populate their peer list.
 *
 * We announce an SRV record so peers can resolve our host + port without
 * needing a TXT record, plus an A/AAAA via the OS's normal mDNS responder.
 */
function announce(): void {
	if (!mdnsServer) return;
	const name = `${deviceHost()}.${SERVICE_TYPE}`;
	try {
		mdnsServer.respond({
			answers: [
				{
					name: SERVICE_TYPE,
					type: 'PTR',
					ttl: 120,
					data: name,
				},
				{
					name,
					type: 'SRV',
					ttl: 120,
					data: { priority: 0, weight: 0, port: servicePort(), target: `${deviceHost()}.local` },
				},
				{
					name,
					type: 'TXT',
					ttl: 120,
					data: [Buffer.from(`deviceId=${deviceHost()}`)],
				},
			],
		});
	} catch (e) {
		// mDNS is best-effort; never crash the app over a broadcast failure.
		console.warn('[lan-peers] mDNS announce failed:', (e as Error).message);
	}
}

/**
 * Handle an mDNS response from another Pi. We only care about answers
 * carrying our SERVICE_TYPE PTR + SRV pair. Exported for tests.
 */
export function handleResponse(resp: { answers?: Array<{ name: string; type: string; data: unknown }> }): void {
	if (!resp.answers) return;
	let deviceId: string | null = null;
	let port: number | null = null;
	let host: string | null = null;
	for (const ans of resp.answers) {
		if (ans.type === 'SRV' && typeof ans.name === 'string' && ans.name.endsWith(SERVICE_TYPE)) {
			const srv = ans.data as { port: number; target: string };
			port = srv.port;
			host = srv.target;
			// Extract the first label as the device id.
			deviceId = ans.name.split('.')[0] ?? null;
		}
	}
	if (deviceId && port && host && deviceId !== deviceHost()) {
		// mDNS answers are untrusted: deviceId becomes the peer-map key and is
		// rendered in the admin UI, so it must be hostname-shaped (the same
		// allowlist the heartbeat store enforces). New entries beyond
		// MAX_PEERS are dropped — refreshes of known peers always land.
		if (!DEVICE_ID_PATTERN.test(deviceId)) return;
		const roster = pinnedPeers();
		if (roster && !roster.has(deviceId)) return;
		if (!peers.has(deviceId) && peers.size >= MAX_PEERS) return;
		peers.set(deviceId, { deviceId, host, port, lastSeen: Date.now() });
	}
}

/**
 * Start the LAN proxy. Idempotent — calling twice is a no-op.
 * Returns a stop function for test teardown.
 */
export function startLanProxy(): () => void {
	if (mdnsServer) return () => {};
	try {
		mdnsServer = mdns();
		mdnsServer.on('response', handleResponse);
		// Kick off discovery by querying for our own service type. Any peer
		// already running will respond, populating our peer map immediately.
		mdnsServer.query({ questions: [{ name: SERVICE_TYPE, type: 'PTR' }] });
		announce();
		announceTimer = setInterval(() => {
			announce();
			gcPeers();
		}, ANNOUNCE_INTERVAL_MS);
	} catch (e) {
		console.warn('[lan-peers] mDNS start failed (LAN proxy disabled):', (e as Error).message);
	}
	return stopLanProxy;
}

/** Stop announcing, tear down the socket, and clear the peer map. Exported for test teardown. */
export function stopLanProxy(): void {
	if (announceTimer) {
		clearInterval(announceTimer);
		announceTimer = null;
	}
	if (mdnsServer) {
		try { mdnsServer.destroy(); } catch { /* already torn down */ }
		mdnsServer = null;
	}
	peers.clear();
}
