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
import { resolveMediaUrl, splitMediaByKind, type WallSnapshot, type WallState } from '#lib/wall.js';

export class WallSync {
	/**
	 * Origin the snapshots come from, used as the base for root-relative media
	 * URLs. Empty (the default) means this pane polls itself, so a relative URL
	 * already points at the right host and is left alone.
	 *
	 * It lives here rather than in `applyWallState` because it is a property of
	 * the CHANNEL, not of a snapshot: the origin that served the state is the
	 * origin holding the files the state names. See `resolveMediaUrl`.
	 */
	constructor(readonly origin: string = '') {}

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
		/**
		 * `due.applyAtWallSec`, NOT `wallSec`.
		 *
		 * A preset SOLVES a clock against the second it is composed for, so the
		 * second passed here is an input to the result -- and `wallSec` is when
		 * this pane got round to applying, which is not a wall-agreed quantity.
		 * A pane that applies late (it was rebooting, its poll stalled, or it
		 * simply booted after the push and read the snapshot on its first GET)
		 * then solves a DIFFERENT clock from its neighbours, permanently, until
		 * the next push.
		 *
		 * And it does not degrade gently. The solve lands on quarter hours, so
		 * 30 s late and 300 s late are identical -- and 3600 s late is a FULL
		 * HOUR of clock offset between panes of one wall. Measured: on-time
		 * 8.75 h, an hour late 7.75 h. A rebooted Pi rejoining the wall is the
		 * normal case, not an edge case.
		 *
		 * `applyAtWallSec` is the one second every pane agrees on. It is the
		 * entire reason the field exists; the apply had been ignoring it for
		 * everything except deciding WHEN.
		 */
		applyWallState(due.state, config, due.applyAtWallSec, this.origin);
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
export function applyWallState(
	state: WallState,
	config: PaneSettings,
	wallSec: number,
	origin = ''
): void {
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
		/**
		 * Split, because `video` mode renders a `<video>` and `screensaver` a
		 * `<img>`: handing both the same list put `.mp4`s inside an `<img src>`
		 * and rendered the failure pane. See `splitMediaByKind`.
		 */
		const urls = state.mediaUrls.map((u) => resolveMediaUrl(u, origin));
		const { videos, stills } = splitMediaByKind(urls);
		config.videoPlaylist = videos;
		config.screensaverUrls = stills;
		config.videoUrl = videos[0] ?? '';
		config.videoIndex = 0;
	}

	/**
	 * Audio, on the same terms as the video list above and with the same `?? []`
	 * for the same reason: a snapshot buffered across the deploy that adds this
	 * field has to apply rather than throw.
	 *
	 * Empty means "keep what the pane booted with", so a weather push does not
	 * silence a wall someone provisioned with `?audio=`. A non-empty list
	 * implies `playlist` mode and sound ON, because a URL naming tracks with the
	 * mode still at `synth` is two switches for one intent -- the argument
	 * `settings.svelte.ts` already makes for the `?audio=` parameter.
	 */
	if ((state.audioUrls ?? []).length > 0) {
		config.audioPlaylist = state.audioUrls.map((u) => resolveMediaUrl(u, origin));
		config.audioTrackIndex = 0;
		config.audioMode = 'playlist';
		config.audioEnabled = true;
	}

	config.weather = state.weather as PaneSettings['weather'];
	// Not when a preset is present: that solve is the whole point of the preset.
	if (!state.presetId) config.clockOffsetH = state.clockOffsetH;
	config.displayMode = state.displayMode as PaneSettings['displayMode'];
	config.blindOpen = state.blindOpen;
	config.rotate = state.rotate;
}
