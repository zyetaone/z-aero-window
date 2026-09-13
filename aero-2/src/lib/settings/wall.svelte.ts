/**
 * The receiving half of the wall state: a buffer, and one function that empties
 * it at a named second.
 *
 * THE BUG THIS EXISTS TO AVOID. The obvious implementation applies a snapshot
 * when its fetch resolves. That makes network jitter an input to the pose:
 * three panes with three different fetch latencies render three different
 * configs at the same `wallSec`. It is `+= dt` arriving over the network, and
 * the source scan cannot see it because there is no accumulator to spot.
 *
 * So the fetch only fills a buffer. Nothing but `advanceTo` ever acts on it,
 * through `applyDue(wallSec, config)`, which makes the assignment itself a pure
 * function of the wall clock:
 *
 *     world = f(wallSec, effectiveWall(wallSec, snapshots), paneKnobs, daySeed)
 *
 * Two panes that received the same snapshot 1.5 s apart compute identical
 * config at every `wallSec`.
 */

import { Location } from './locations.js';
import type { PaneSettings } from './settings.svelte.js';
import type { WallSnapshot, WallState } from '#lib/wall.js';

export class WallSync {
	/** Highest version applied. Also what the poller conditions its GET on. */
	appliedVersion = $state(0);
	/** Buffered and not yet due. Read by the drawer's "applies in Ns" countdown. */
	pending = $state.raw<WallSnapshot | null>(null);

	/**
	 * Buffer a snapshot. Deliberately does nothing else — receiving is not
	 * applying, and that separation is the whole design.
	 *
	 * Monotonic in version against BOTH what has applied and what is already
	 * waiting. The applied check alone left a hole: two pushes inside the 5 s
	 * lead are both un-applied, so `appliedVersion` is still behind both, and a
	 * v1 arriving after a v2 replaced the newer snapshot and landed the
	 * operator's abandoned choice on the wall. Nothing in `receive`'s contract
	 * promised ordered delivery — the poller's `inFlight` guard makes it
	 * unlikely on one pane, not impossible across a retry, a caching
	 * intermediary, or a future caller — and a rule that depends on an
	 * undocumented property of one call site is a rule waiting to break.
	 *
	 * A newer push still supersedes an older one still waiting: the operator
	 * changed their mind inside the lead time, and only the last should land.
	 */
	receive(snapshot: WallSnapshot | null | undefined): void {
		if (!snapshot) return;
		const floor = Math.max(this.appliedVersion, this.pending?.version ?? 0);
		if (snapshot.version <= floor) return;
		this.pending = snapshot;
	}

	/**
	 * Apply the buffered snapshot if its second has arrived. Called from
	 * `advanceTo` BEFORE `director.tick`, so a snapshot that pins a place and
	 * clears `rotate` is seen by the same tick that would otherwise have rotated
	 * past it — the existing flag arbitrates, no new logic.
	 */
	applyDue(wallSec: number, config: PaneSettings): void {
		const due = this.pending;
		if (!due || wallSec < due.applyAtWallSec) return;

		this.pending = null;
		this.appliedVersion = due.version;
		applyWallState(due.state, config, wallSec);
	}
}

/**
 * Assign the seven wall keys, and nothing else.
 *
 * `wallSec` is threaded into `applyPreset` rather than letting it default.
 * Its docstring accepted a defaulted clock because a preset was an operator
 * action on one pane — true then. Arriving through a shared `applyAtWallSec` it
 * IS a derived quantity, so the second it is derived from has to be the one
 * every pane agrees on.
 */
export function applyWallState(state: WallState, config: PaneSettings, wallSec: number): void {
	/**
	 * Preset first, and for `place`/`clockOffsetH` it also wins.
	 *
	 * The rule used to be "anything explicit in the snapshot lands after the
	 * preset and wins", which is right for every field an operator can actually
	 * set — and wrong for the two the preset SOLVES. `applyPreset` runs
	 * `localHourAtSunElevation` against `wallSec`, because "golden hour" is a
	 * sun angle and the hour that produces it moves ~3 h across the year. Only
	 * the pane knows `wallSec` at apply time.
	 *
	 * The operator draft seeds `clockOffsetH` once at panel load and no effect
	 * recomputes it when a preset is picked, so the "explicit" value was never
	 * explicit — it was whatever the panel happened to boot with, and it
	 * overwrote the solve on every push. A preset pushed to the wall arrived
	 * without its clock.
	 *
	 * So the order is inverted: the snapshot's place lands FIRST, and the preset
	 * lands on top of it. A preset that names a place overrides it; one that
	 * does not leaves the snapshot's place standing. No knowledge of the
	 * preset's shape is needed here to get that right.
	 */
	if (state.placeId) config.setPlace(Location.byId(state.placeId));
	if (state.presetId) config.applyPreset(state.presetId, wallSec);

	/**
	 * Media before mode. `displayMode` lands below; if the list landed after a
	 * pane could render one frame of `video` against the OLD playlist. Empty
	 * means "keep what the pane booted with", so a flight-only push never
	 * clobbers a URL-provisioned playlist.
	 */
	/**
	 * `?? []`, and not because the type allows it — it does not. A wall file
	 * written before this field existed is still on disk on every fielded Pi,
	 * and `readWall` parses it with the CURRENT parser: version pins mean the
	 * server rejects such a push, but the pane-side buffer can still carry a
	 * pre-upgrade snapshot across the exact deploy that adds the field. A
	 * schema addition has to tolerate its own rollout.
	 */
	if ((state.mediaUrls ?? []).length > 0) {
		config.videoPlaylist = state.mediaUrls.slice();
		config.screensaverUrls = state.mediaUrls.slice();
		config.videoUrl = state.mediaUrls[0] ?? '';
		config.videoIndex = 0;
	}

	config.weather = state.weather as PaneSettings['weather'];
	// Not when a preset is present: that solve is the whole point of the preset.
	if (!state.presetId) config.clockOffsetH = state.clockOffsetH;
	config.displayMode = state.displayMode as PaneSettings['displayMode'];
	config.blindOpen = state.blindOpen;
	config.rotate = state.rotate;
}
