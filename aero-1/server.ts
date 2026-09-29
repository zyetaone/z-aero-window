/**
 * Server entry — starts the LAN mDNS peer advertiser, then hands HTTP over
 * to adapter-node's own server (build/index.js).
 *
 * Product: Zyeta Aero Dynamic Window · engineered by rdtect
 * (attribution SSOT: src/lib/credits.ts — do not re-import here; this file
 * is Bun-native and not Vite-built for defines, but a plain comment is fine).
 *
 * Post-WS: there's no custom transport layer here anymore. Admin talks
 * to each device's REST endpoints (/api/config, /api/status, /api/command)
 * over LAN, and each device's browser subscribes to its own SvelteKit-
 * served /api/events SSE route. All of that runs through the built
 * handler — this entry just keeps `startLanProxy()` alive so mDNS
 * discovery works.
 *
 * ⚠ DO NOT re-wrap the handler in Bun.serve({ fetch: handler }). adapter-node
 * exports `handler` as polka/Connect MIDDLEWARE — (req: IncomingMessage,
 * res: ServerResponse, next) — not a fetch-style (Request) => Response.
 * Calling it with a Request passed `undefined` as `res`, so the FIRST
 * request hit `res.statusCode = 400` inside the handler's own catch →
 * TypeError → unhandledRejection → exit(1) → systemd Restart=always →
 * 10s crash loop with a dark kiosk. build/index.js already wires the
 * middleware to a real HTTP server; don't re-implement it.
 *
 * Run: bun run build && bun run server.ts
 */

import { existsSync } from 'node:fs';
import { startLanProxy } from './src/lib/server/fleet/lan-peers';
import { installMemoryPressureGuard } from './src/lib/server/memory-pressure';

// adapter-node reads PORT/HOST from env at import time and defaults PORT to
// 3000. Set this project's default BEFORE importing it so `bun run serve`
// with no PORT still lands on 5173.
process.env.PORT ||= '5173';
const PORT = parseInt(process.env.PORT, 10);

// Production hardening — a crash must be DEBUGGABLE, not silent. Log the
// reason, then exit non-zero so systemd (Restart=always, RestartSec=10)
// brings the process back; journalctl keeps the line for the operator.
// NOTE: no $lib/version import here — server.ts is run by Bun directly,
// not Vite-built, so Vite `define`s don't exist in this file.
process.on('unhandledRejection', (reason) => {
	console.error('[server] FATAL unhandledRejection:', reason);
	process.exit(1);
});
process.on('uncaughtException', (err) => {
	console.error('[server] FATAL uncaughtException:', err);
	process.exit(1);
});

// OS-level memory pressure (Bun 1.4+; PSI on Linux fires only at
// "critical"). The kiosk's Chromium — not this process — is the big
// consumer on a 2 GB Pi, so this can't free its memory; it logs for
// journalctl correlation and sheds this process's dispensable state.
// No-op on pre-1.4 runtimes, where the event never fires.
installMemoryPressureGuard();

// mDNS peer discovery + announce. Silent-fails on platforms without
// multicast (Docker-networked-host, some WSL2 setups) — the app keeps
// running, it just can't find LAN peers. On the Pi, a straight multicast
// socket on the LAN is always available.
if (process.env.AERO_DISABLE_LAN_PROXY !== '1') {
	try {
		startLanProxy();
		console.log('[server] LAN peer discovery started (mDNS _aero-bundle._tcp.local)');
	} catch (e) {
		console.warn('[server] LAN peer discovery failed to start:', (e as Error).message);
	}
}

// The server is produced by `bun run build`. In dev we usually run
// `bun run dev` (Vite) instead and this entry point is unused. Probe for the
// artifact rather than try/catch-ing the import, so a REAL failure inside
// build/index.js (port already bound, bad env) still crashes loudly instead
// of being swallowed into the degraded branch below.
const BUILD_ENTRY = new URL('./build/index.js', import.meta.url);

if (existsSync(BUILD_ENTRY)) {
	// Starts listening on PORT/HOST as a side effect of the import.
	await import('./build/index.js');
	console.log(`[server] Aero Window listening on http://localhost:${PORT}`);
} else {
	// Degraded, NOT looping: stay up and serve 503 so the box is reachable
	// and diagnosable. aero-updater.sh's probe_health uses `curl -f`, so this
	// 503 correctly fails the post-restart probe and triggers its rollback.
	console.warn('[server] No build/ found — run `bun run build` first, or use `bun run dev` for the Vite server.');
	Bun.serve({
		port: PORT,
		fetch: () =>
			new Response(
				'Aero server: no build found. Run `bun run build` (then `bun run server.ts`), or use `bun run dev`.',
				{ status: 503, headers: { 'Content-Type': 'text/plain' } },
			),
	});
	console.log(`[server] Aero Window listening (degraded, no build) on http://localhost:${PORT}`);
}
