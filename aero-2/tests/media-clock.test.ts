import { describe, it, expect } from 'vitest';
import {
	DRIFT_TOLERANCE_SEC,
	decideCorrection,
	playlistPosition
} from '#lib/display/media/media-clock.js';

/**
 * The invariant the counters could never satisfy: two panes holding the same
 * playlist at the same second are at the same place in it, however long
 * either has been running and whenever either booted.
 */
describe('playlistPosition', () => {
	const durations = [30, 45, 15]; // 90 s cycle

	it('walks the playlist back to back from t = 0', () => {
		expect(playlistPosition(0, durations)).toEqual({ index: 0, offsetSec: 0 });
		expect(playlistPosition(29.5, durations)).toEqual({ index: 0, offsetSec: 29.5 });
		expect(playlistPosition(30, durations)).toEqual({ index: 1, offsetSec: 0 });
		expect(playlistPosition(74, durations)).toEqual({ index: 1, offsetSec: 44 });
		expect(playlistPosition(75, durations)).toEqual({ index: 2, offsetSec: 0 });
	});

	it('wraps: the cycle repeats forever, and a late pane lands where an on-time one is', () => {
		const onTime = playlistPosition(1_789_300_000, durations);
		for (const lateBy of [90, 3600, 86_400]) {
			expect(playlistPosition(1_789_300_000 + lateBy, durations), `${lateBy}s later`).toEqual(
				// 3600 and 86400 are both multiples of 90; 90 is one full cycle.
				onTime
			);
		}
		expect(playlistPosition(90 + 31, durations)).toEqual({ index: 1, offsetSec: 1 });
	});

	it('two panes, same list, same second → same answer, whatever their uptime', () => {
		// "Uptime" is not an input. That is the whole point.
		const a = playlistPosition(123_456.7, durations);
		const b = playlistPosition(123_456.7, durations);
		expect(a).toEqual(b);
	});

	it('a single item is just its own modulus', () => {
		expect(playlistPosition(65, [30])).toEqual({ index: 0, offsetSec: 5 });
	});

	/**
	 * Unknown durations → null, never a guess. A pane that guessed would
	 * disagree with one that knew; the caller's fallback is the same on every
	 * pane (item 0, offset from that item's own metadata), so the wall converges
	 * as probes land instead of forking while they do.
	 */
	it('refuses to answer until every duration is known', () => {
		expect(playlistPosition(10, [])).toBeNull();
		expect(playlistPosition(10, [30, NaN, 15])).toBeNull();
		expect(playlistPosition(10, [30, 0, 15])).toBeNull();
		expect(playlistPosition(10, [30, -1])).toBeNull();
	});

	it('negative wall seconds do not produce a negative offset', () => {
		expect(playlistPosition(-5, [30])).toEqual({ index: 0, offsetSec: 25 });
	});
});

/**
 * The adversary's objection, turned into the check: a media clock free-runs,
 * so correction is a loop, and a loop with a tolerance below the seek latency
 * thrashes. These pin the guards that keep it from doing nothing or doing too
 * much.
 */
describe('decideCorrection', () => {
	const ready = (currentTime: number) => ({ currentTime, readyState: 4, seeking: false });

	it('leaves a playhead alone inside the tolerance band', () => {
		expect(decideCorrection(ready(10.0), 10.0)).toBe(false);
		expect(decideCorrection(ready(10.0), 10.0 + DRIFT_TOLERANCE_SEC)).toBe(false);
		expect(decideCorrection(ready(10.0), 10.0 - DRIFT_TOLERANCE_SEC)).toBe(false);
	});

	it('pulls it back once it has drifted past the band, either way', () => {
		expect(decideCorrection(ready(10.0), 10.0 + DRIFT_TOLERANCE_SEC + 0.01)).toBe(true);
		expect(decideCorrection(ready(10.0), 10.0 - DRIFT_TOLERANCE_SEC - 0.01)).toBe(true);
	});

	it('never seeks mid-seek — a queued seek lands nowhere', () => {
		expect(decideCorrection({ currentTime: 0, readyState: 4, seeking: true }, 50)).toBe(false);
	});

	it('never seeks before metadata — the element drops it silently', () => {
		expect(decideCorrection({ currentTime: 0, readyState: 0, seeking: false }, 50)).toBe(false);
	});

	it('the tolerance is wider than a Pi 5 keyframe seek, or the loop thrashes', () => {
		// Hundreds of milliseconds per seek; below that this becomes seek →
		// land behind → seek again. Pinned so a "tighter is better" edit fails here.
		expect(DRIFT_TOLERANCE_SEC).toBeGreaterThanOrEqual(0.75);
	});
});
