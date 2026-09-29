/**
 * Memory-pressure guard — server-only, called once from server.ts.
 *
 * Bun 1.4+ emits `memoryPressure` on `process` when the operating system
 * reports memory pressure. On Linux this is a PSI trigger on
 * /proc/pressure/memory and only fires at level "critical" — the OOM killer
 * is a live threat, not a risk. On macOS both "warning" and "critical"
 * arrive. On pre-1.4 runtimes the event never fires; registering the
 * listener is a harmless no-op, so fielded Pis still on an older Bun (see
 * the pin + drift note in deploy/pi/install.sh) lose nothing.
 *
 * What the guard can and cannot do: the big consumer on a 2 GB Pi is the
 * kiosk's Chromium, a separate process this one cannot free memory from.
 * So the guard does the two things it CAN do:
 *   1. Record the event in the journal ([memory-pressure] level=…) so an
 *      operator correlating a kiosk crash in journalctl has a timestamped
 *      OS-level cause, not just "process died".
 *   2. Drop this process's own dispensable state (the bundle disk cache)
 *      so the server stays the LEAST likely OOM victim.
 *
 * A browser-side response — push the event over the /api/events SSE bus so
 * the kiosk can shed cloud layers or clear its tile cache before Chromium
 * gets killed — is a deliberate follow-up, not part of this guard.
 *
 * No runes: this runs in the server process, imported by server.ts, never
 * bundled into the client.
 */

import { invalidateCache as invalidateBundleCache } from './bundle/disk';

export type MemoryPressureLevel = 'warning' | 'critical';

export interface MemoryPressureGuardOptions {
	/**
	 * Called after the event is logged. Default: invalidate the bundle
	 * disk cache (lazy, re-hydrates from disk on next access). Injected in
	 * tests so the effect is observable without poking disk internals.
	 */
	release?: (level: MemoryPressureLevel) => void;
}

let installed: ((level: MemoryPressureLevel) => void) | null = null;

/**
 * Register the process-level `memoryPressure` listener. Idempotent —
 * installing twice replaces the previous listener rather than stacking.
 * Returns an uninstall function.
 */
export function installMemoryPressureGuard(options: MemoryPressureGuardOptions = {}): () => void {
	const release = options.release ?? ((): void => {
		invalidateBundleCache();
	});

	const listener = (level: MemoryPressureLevel): void => {
		const usage = process.memoryUsage();
		console.warn(
			`[memory-pressure] level=${level} ` +
			`rss=${Math.round(usage.rss / 1024 / 1024)}MB heapUsed=${Math.round(usage.heapUsed / 1024 / 1024)}MB ` +
			`— dropping server-side caches`,
		);
		try {
			release(level);
		} catch (e) {
			// A failing release must never mask the log line above — the log
			// is the primary deliverable (journal correlation).
			console.warn('[memory-pressure] release failed:', e instanceof Error ? e.message : e);
		}
	};

	if (installed) process.removeListener('memoryPressure', installed);
	installed = listener;
	process.on('memoryPressure', listener);

	return () => {
		process.removeListener('memoryPressure', listener);
		if (installed === listener) installed = null;
	};
}
