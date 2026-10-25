/**
 * Overlay recovery — auto-disable the Three overlay on underpowered hardware.
 *
 * The liveness watchdog only catches fps == 0 (stall/death). A Pi 5 that can
 * handle Cesium at ~8 fps but drops to ~3 fps with the Three overlay is never
 * "dead" — just silently degraded. This module detects sustained low fps and
 * disables the overlay, persisting the decision in localStorage so a fleet-
 * deployed Pi stays in Cesium-only mode across reboots until an operator
 * manually re-enables it.
 *
 * Framework-free — no runes, testable. Wire-up in GlobeLayer.svelte.
 */

/** Three consecutive 30s checks below this fps threshold triggers disable. */
const FPS_MIN_THRESHOLD = 5;
const CHECK_INTERVAL_MS = 30_000;
const CONSECUTIVE_CHECKS = 3;

const OVERLAY_DISABLED_KEY = 'aero-overlay-disabled';

/** Check whether the overlay was previously disabled due to low performance. */
export function isOverlayPersistentlyDisabled(): boolean {
	try {
		return localStorage.getItem(OVERLAY_DISABLED_KEY) === '1';
	} catch {
		return false;
	}
}

/** Persist the disabled state in localStorage so it survives reboot. */
function persistDisabled(): void {
	try {
		localStorage.setItem(OVERLAY_DISABLED_KEY, '1');
	} catch {
		/* localStorage unavailable — still disable in-memory */
	}
}

/** Clear the persistent disable (called when the overlay is re-enabled via SidePanel or URL param). */
export function clearOverlayDisabled(): void {
	try {
		localStorage.removeItem(OVERLAY_DISABLED_KEY);
	} catch {
		/* noop */
	}
}

/**
 * True when the URL carries an explicit `?overlay=` override (the perf-gate
 * A/B param parsed in +page.svelte). An explicit operator choice must win
 * over the persisted auto-disable, so the boot-time check in GlobeLayer
 * skips applying the persisted flag when this is set.
 */
export function hasExplicitOverlayParam(): boolean {
	if (typeof window === 'undefined') return false;
	try {
		return new URLSearchParams(window.location.search).has('overlay');
	} catch {
		return false;
	}
}

interface OverlayRecoveryOptions {
	/** Called to read the current measured fps. */
	getFps: () => number;
	/** Called to disable the overlay (applyConfigPatch + persist). */
	disableOverlay: () => void;
	/** Check interval, ms. Default 30s. */
	intervalMs?: number;
	/** FPS threshold to consider "too slow". Default 5. */
	fpsMinThreshold?: number;
	/** Consecutive slow checks required. Default 3 (≥90s sustained low fps). */
	slowChecksRequired?: number;
}

/**
 * Start the overlay recovery monitor. Returns a stop function.
 *
 * Design: separate from the liveness watchdog — the watchdog handles "dead"
 * (fps=0) and this handles "alive but too slow." Both run from
 * GlobeLayer.svelte $effects and use the same measuredFps source. They don't
 * interact.
 */
export function startOverlayRecovery(opts: OverlayRecoveryOptions): () => void {
	const intervalMs = opts.intervalMs ?? CHECK_INTERVAL_MS;
	const threshold = opts.fpsMinThreshold ?? FPS_MIN_THRESHOLD;
	const required = opts.slowChecksRequired ?? CONSECUTIVE_CHECKS;
	let consecutiveSlow = 0;
	// Latch: once fired, don't re-fire disableOverlay (a persisted config
	// patch; the kiosk runs no peer-sync, so nothing is broadcast) on every interval while the slowness persists. A healthy
	// check resets the latch so a LATER sustained regression re-fires.
	let reported = false;

	const id = setInterval(() => {
		if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
			consecutiveSlow = 0;
			return;
		}
		const fps = opts.getFps();
		if (fps <= 0) {
			return;
		}
		if (fps >= threshold) {
			consecutiveSlow = 0;
			reported = false;
			return;
		}
		consecutiveSlow++;
		if (consecutiveSlow >= required && !reported) {
			reported = true;
			persistDisabled();
			opts.disableOverlay();
		}
	}, intervalMs);

	return () => clearInterval(id);
}
