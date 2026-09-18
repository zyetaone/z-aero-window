/**
 * media-clock — where a playlist SHOULD be at a given wall second.
 *
 * The slideshow already derives its slide from the clock; video and audio did
 * not. `videoIndex += 1` on `onended` is a per-process sequence — three Pis
 * boot seconds apart and play three different clips — and a playhead that is
 * never seeded means even ONE clip on `loop` is three loops drifting. Both are
 * the failure ADR-007 exists to rule out, on the two surfaces it was not
 * applied to.
 *
 * A slide index is discrete; a playing media clock free-runs. Decode stalls
 * and dropped frames on a Pi 5 pull `currentTime` away from where the wall
 * says it should be, so a one-time seed is not enough: `decideCorrection` is
 * the per-second check that pulls it back. Rune-free pure math so the same
 * answer is testable without a DOM and identical on every pane.
 */

export interface PlaylistPosition {
	/** Which item is playing at this second. */
	index: number;
	/** How far into that item, in seconds. */
	offsetSec: number;
}

/**
 * Position in a playlist whose items play back to back, forever, from t = 0.
 *
 * Returns `null` until every duration is known: a pane that guessed would
 * disagree with a pane that knew. The caller's fallback must be the SAME on
 * every pane — item 0, offset from that item's own metadata — so the wall
 * converges as the probes land rather than forking while they do.
 */
export function playlistPosition(
	wallSec: number,
	durationsSec: readonly number[]
): PlaylistPosition | null {
	if (durationsSec.length === 0) return null;
	let total = 0;
	for (const d of durationsSec) {
		if (!Number.isFinite(d) || d <= 0) return null;
		total += d;
	}
	let t = ((wallSec % total) + total) % total;
	for (let i = 0; i < durationsSec.length; i++) {
		if (t < durationsSec[i]) return { index: i, offsetSec: t };
		t -= durationsSec[i];
	}
	// Floating-point tail: t landed on `total` exactly. Last item, its end.
	return { index: durationsSec.length - 1, offsetSec: durationsSec[durationsSec.length - 1] };
}

/**
 * How far off the wall a playhead may be before it is pulled back.
 *
 * Wide on purpose. A seek on a Pi 5 is a decode from the previous keyframe,
 * hundreds of milliseconds, and a tolerance below that latency thrashes: seek,
 * land behind, seek again. One second is well above the seek cost and well
 * below what a passer-by reads as "the three screens disagree" — that takes a
 * visibly different frame, which for most content is several seconds.
 *
 * ponytail: seek-only correction. If seeks are visible on hardware, the
 * upgrade is a ±5 % `playbackRate` nudge inside the tolerance band and a seek
 * only outside it.
 */
export const DRIFT_TOLERANCE_SEC = 1.0;

export interface PlayheadState {
	currentTime: number;
	/** HTMLMediaElement.readyState: 0 = nothing yet, ≥ 1 = metadata known. */
	readyState: number;
	seeking: boolean;
}

/**
 * Whether to seek, given where the element is and where the wall says it
 * should be. A seek mid-seek re-queues and never lands; a seek before
 * metadata is silently dropped by the element. Both read as "the correction
 * does nothing", so both are refused here rather than at the call site.
 */
export function decideCorrection(
	el: PlayheadState,
	targetSec: number,
	toleranceSec = DRIFT_TOLERANCE_SEC
): boolean {
	if (el.seeking || el.readyState < 1) return false;
	return Math.abs(el.currentTime - targetSec) > toleranceSec;
}
