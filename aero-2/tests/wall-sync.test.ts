import { describe, it, expect } from 'vitest';
import { WallSync, applyWallState } from '#lib/settings/wall.svelte.js';
import { createSettings } from '#lib/settings/settings.svelte.js';
import { seedMediaDraft, unresolveMediaUrl, type WallSnapshot, type WallState } from '#lib/wall.js';

const state = (over: Partial<WallState> = {}): WallState => ({
	placeId: 'denver',
	presetId: '',
	weather: 'rain',
	clockOffsetH: 3,
	displayMode: 'flight',
	blindOpen: false,
	rotate: false,
	mediaUrls: [],
	audioUrls: [],
	...over
});

const snap = (
	version: number,
	applyAtWallSec: number,
	over: Partial<WallState> = {}
): WallSnapshot => ({
	version,
	applyAtWallSec,
	state: state(over)
});

describe('WallSync', () => {
	it('buffers a snapshot without applying it', () => {
		const sync = new WallSync();
		const config = createSettings();
		const before = config.weather;

		sync.receive(snap(1, 100));
		expect(sync.pending?.version).toBe(1);
		expect(config.weather).toBe(before);
		expect(sync.appliedVersion).toBe(0);
	});

	/**
	 * The bug this class exists for. Two panes that received the same snapshot
	 * at different instants must reach identical config at the same wallSec —
	 * otherwise fetch latency is an input to the pose, which is `+= dt` arriving
	 * over the network.
	 */
	it('applies at the named second, not at the moment of receipt', () => {
		const early = new WallSync();
		const late = new WallSync();
		const a = createSettings();
		const b = createSettings();

		early.receive(snap(1, 100));
		// `late` receives 4 wall-seconds later, as a slow pane would.
		for (let t = 96; t < 100; t++) early.applyDue(t, a);
		late.receive(snap(1, 100));

		expect(a.weather).not.toBe('rain'); // not yet due for either
		early.applyDue(100, a);
		late.applyDue(100, b);

		expect(a.weather).toBe('rain');
		expect(b.weather).toBe('rain');
		expect(a.clockOffsetH).toBe(b.clockOffsetH);
		expect(a.place.id).toBe(b.place.id);
	});

	/**
	 * The hole the test above leaves, and the reason it stayed open: both panes
	 * there apply at EXACTLY the scheduled second, which is the one input where
	 * "when did this pane apply" and "when was this scheduled" are the same
	 * number. Off that anchor they are not, and a preset SOLVES its clock
	 * against the second it is given.
	 *
	 * A pane applies late whenever it was rebooting, its poll stalled, or it
	 * simply booted after the push and read the snapshot on its first GET --
	 * which is the ordinary "one Pi came back" case on a three-pane wall.
	 *
	 * It does not degrade gently either. The solve lands on quarter hours, so
	 * 30 s and 300 s late are indistinguishable, and an hour late is a FULL
	 * HOUR of clock offset between panes showing one panorama.
	 */
	it('lands the same clock however late a pane gets to it', () => {
		const at = 1_789_300_000;
		const onTime = createSettings();
		const early = new WallSync();
		early.receive(snap(1, at, { presetId: 'gulf-midnight', placeId: '' }));
		early.applyDue(at, onTime);

		for (const lateBy of [30, 300, 3600, 86_400]) {
			const sync = new WallSync();
			const config = createSettings();
			sync.receive(snap(1, at, { presetId: 'gulf-midnight', placeId: '' }));
			sync.applyDue(at + lateBy, config);
			expect(config.clockOffsetH, `applied ${lateBy}s late`).toBe(onTime.clockOffsetH);
			expect(config.place.id, `applied ${lateBy}s late`).toBe(onTime.place.id);
		}
	});

	it('applies once, then has nothing left to apply', () => {
		const sync = new WallSync();
		const config = createSettings();
		sync.receive(snap(1, 100));
		sync.applyDue(100, config);

		expect(sync.pending).toBeNull();
		expect(sync.appliedVersion).toBe(1);

		config.weather = 'clear';
		sync.applyDue(200, config);
		expect(config.weather).toBe('clear');
	});

	it('ignores a version it has already applied, or an older one', () => {
		const sync = new WallSync();
		const config = createSettings();
		sync.receive(snap(2, 100));
		sync.applyDue(100, config);

		sync.receive(snap(2, 200));
		sync.receive(snap(1, 200));
		expect(sync.pending).toBeNull();
	});

	/**
	 * An operator changing their mind inside the lead time: only the last push
	 * should land, not both in sequence.
	 */
	it('supersedes a pending snapshot with a newer one', () => {
		const sync = new WallSync();
		const config = createSettings();
		sync.receive(snap(1, 100, { weather: 'rain' }));
		sync.receive(snap(2, 100, { weather: 'storm' }));
		sync.applyDue(100, config);

		expect(config.weather).toBe('storm');
		expect(sync.appliedVersion).toBe(2);
	});
});

describe('applyWallState', () => {
	it('assigns every wall key', () => {
		const config = createSettings();
		applyWallState(state(), config, 0);
		expect(config).toMatchObject({
			weather: 'rain',
			clockOffsetH: 3,
			displayMode: 'flight',
			blindOpen: false,
			rotate: false
		});
		expect(config.place.id).toBe('denver');
	});

	/**
	 * REVERSED, deliberately. This used to assert that explicit keys win over
	 * the preset that also sets them, on the argument that a snapshot should
	 * not mean different things depending on whether a preset was set.
	 *
	 * The argument is right for every field an operator can actually set, and
	 * wrong for the two the preset SOLVES. `gulf-midnight` names Dubai and
	 * solves an offset for midnight THERE — `applyPreset`'s own comment says
	 * "setPlace first: the offset is relative to the DESTINATION's local time".
	 * Landing `denver` on top of it left Denver wearing Dubai's offset, which is
	 * the same failure `settings.svelte.ts` already documents for `?preset=`:
	 * "observed rendering Chicago Midway in daylight: wrong place, and the wrong
	 * time for it."
	 *
	 * A snapshot carrying a preset AND a different place is contradictory input.
	 * Resolving it as "the preset wins, coherently" beats resolving it as a
	 * mixture that is neither scene.
	 */
	it('lets the preset win over snapshot keys it solves for', () => {
		const config = createSettings();
		const solo = createSettings();
		solo.applyPreset('gulf-midnight', 0);

		applyWallState(
			state({ presetId: 'gulf-midnight', clockOffsetH: 5, placeId: 'denver' }),
			config,
			0
		);
		expect(config.clockOffsetH).toBe(solo.clockOffsetH);
		expect(config.place.id).toBe('dubai');
	});

	it('still lets an explicit clock and place win when no preset is named', () => {
		const config = createSettings();
		applyWallState(state({ presetId: '', clockOffsetH: 5, placeId: 'denver' }), config, 0);
		expect(config.clockOffsetH).toBe(5);
		expect(config.place.id).toBe('denver');
	});

	it('treats an empty id as "nothing pinned" rather than as a lookup', () => {
		const config = createSettings();
		const before = config.place.id;
		applyWallState(state({ placeId: '', presetId: '' }), config, 0);
		expect(config.place.id).toBe(before);
	});
});

/**
 * Audio is the half that had no wall route at all. `audioPlaylist` was
 * reachable only through `?audio=` on one pane's URL, so a song was pane-local
 * and died on reload — on a wall whose premise is that three panes are one
 * window. These are the assertions that it now travels with the scene.
 */
describe('audioUrls on the receive side', () => {
	it('a push with songs fills the playlist and turns the cabin on', () => {
		const config = createSettings();
		applyWallState(state({ audioUrls: ['/api/media/abc123def4567890.mp3'] }), config, 100);
		expect(config.audioPlaylist).toEqual(['/api/media/abc123def4567890.mp3']);
		expect(config.audioTrackIndex, 'a new playlist starts at its first track').toBe(0);
		expect(config.audioMode, 'tracks with the mode still at synth is two switches for one intent').toBe('playlist');
		expect(config.audioEnabled).toBe(true);
	});

	it('reaches every pane identically, which is the entire point', () => {
		const left = createSettings();
		const right = createSettings();
		const push = state({ audioUrls: ['/api/media/aaaaaaaaaaaaaaaa.mp3', '/api/media/bbbbbbbbbbbbbbbb.mp3'] });
		applyWallState(push, left, 100);
		applyWallState(push, right, 100);
		expect(left.audioPlaylist).toEqual(right.audioPlaylist);
		expect(left.audioTrackIndex).toBe(right.audioTrackIndex);
	});

	/**
	 * Empty means "keep what the pane booted with". A weather push must not
	 * silence a wall someone provisioned with `?audio=`.
	 */
	it('an empty list leaves a boot-provisioned soundtrack alone', () => {
		const config = createSettings();
		config.audioPlaylist = ['/boot.mp3'];
		config.audioMode = 'playlist';
		applyWallState(state({ audioUrls: [] }), config, 100);
		expect(config.audioPlaylist).toEqual(['/boot.mp3']);
		expect(config.audioMode).toBe('playlist');
	});

	/**
	 * The same rollout tolerance `mediaUrls` already has. A snapshot buffered
	 * across the deploy that ADDS this field must apply, not throw — the pane
	 * side sees pre-upgrade snapshots even though the server rejects such a
	 * push.
	 */
	it('a snapshot from before audio travelled still applies', () => {
		const config = createSettings();
		const legacy = state();
		delete (legacy as Partial<WallState>).audioUrls;
		expect(() => applyWallState(legacy, config, 100)).not.toThrow();
		expect(config.weather).toBe('rain');
		expect(config.audioMode, 'and must not switch a silent pane to playlist').toBe('synth');
	});
});

describe('mediaUrls on the receive side', () => {
	it('a push with media fills the playlist fields', () => {
		const config = createSettings();
		applyWallState(state({ mediaUrls: ['/a.mp4', '/b.mp4'], displayMode: 'video' }), config, 100);
		expect(config.videoPlaylist).toEqual(['/a.mp4', '/b.mp4']);
		expect(config.videoUrl).toBe('/a.mp4');
		expect(config.videoIndex, 'a new playlist must start at its first track').toBe(0);
		expect(config.displayMode).toBe('video');
	});

	/**
	 * This assertion used to read `toEqual(['/a.mp4', '/b.mp4'])` -- it PINNED
	 * the bug. One list fed both `videoPlaylist` (a `<video>`) and
	 * `screensaverUrls` (an `<img>`), so a clip pushed to a pane sitting in
	 * screensaver mode landed in an `<img src>` and rendered "Media failed to
	 * load". The old test asserted the two fields were equal, which is exactly
	 * the property that makes the bug possible, so it could never fail.
	 */
	it('sorts a mixed list by what can actually render it', () => {
		const config = createSettings();
		applyWallState(
			state({ mediaUrls: ['/a.mp4', '/b.webp', '/c.webm', '/d.jpg'] }),
			config,
			100
		);
		expect(config.videoPlaylist).toEqual(['/a.mp4', '/c.webm']);
		expect(config.screensaverUrls).toEqual(['/b.webp', '/d.jpg']);
		expect(config.videoUrl).toBe('/a.mp4');
	});

	it('an extensionless URL goes to both, because nothing says which it is', () => {
		const config = createSettings();
		applyWallState(state({ mediaUrls: ['https://cdn.example.com/stream'] }), config, 100);
		expect(config.videoPlaylist).toEqual(['https://cdn.example.com/stream']);
		expect(config.screensaverUrls).toEqual(['https://cdn.example.com/stream']);
	});

	/**
	 * The three-pane case, which single-pane testing cannot see: a root-relative
	 * URL resolves against the PANE's origin, but the file lives on the wall
	 * writer. Without the origin, two of three panes 404.
	 */
	it('resolves relative media against the wall origin, and leaves absolute alone', () => {
		const config = createSettings();
		applyWallState(
			state({
				mediaUrls: ['/api/media/abc123def4567890.mp4', 'https://cdn.example.com/x.mp4'],
				audioUrls: ['/api/media/0123456789abcdef.mp3']
			}),
			config,
			100,
			'http://10.0.0.5:3000'
		);
		expect(config.videoPlaylist).toEqual([
			'http://10.0.0.5:3000/api/media/abc123def4567890.mp4',
			'https://cdn.example.com/x.mp4'
		]);
		expect(config.audioPlaylist).toEqual([
			'http://10.0.0.5:3000/api/media/0123456789abcdef.mp3'
		]);
	});

	/**
	 * The leg the one-way test above cannot see. `Wall.svelte` seeds its push
	 * draft from the config the LAST snapshot wrote, so whatever
	 * `resolveMediaUrl` put there comes straight back out. If it comes back
	 * absolute, the picker cannot match it against the relative listing (every
	 * playing track reads "not on this device") and the next push writes
	 * absolute URLs into `wall.json` — the origin-free invariant, destroyed by
	 * the very function that exists to preserve it.
	 *
	 * Calls `seedMediaDraft`, which IS the component's seed expression -- not a
	 * re-implementation of it. A test that spelled the flatten/strip out inline
	 * here would pass while `Wall.svelte` did something else entirely.
	 */
	it('media survives the resolve/seed round trip origin-free', () => {
		const config = createSettings();
		const pushed = ['/api/media/abc123def4567890.mp4', '/api/media/0123456789abcdef.webp'];
		const origin = 'http://10.0.0.5:3000';
		applyWallState(state({ mediaUrls: pushed, audioUrls: ['/api/media/fedcba9876543210.mp3'] }), config, 100, origin);

		expect(seedMediaDraft([config.videoPlaylist, config.screensaverUrls], origin)).toEqual(pushed);
		expect(seedMediaDraft([config.audioPlaylist], origin)).toEqual([
			'/api/media/fedcba9876543210.mp3'
		]);
	});

	it('an extensionless URL, which lands in both lists, seeds back exactly once', () => {
		const config = createSettings();
		applyWallState(state({ mediaUrls: ['https://cdn.example.com/stream'] }), config, 100, 'http://10.0.0.5:3000');
		expect(config.videoPlaylist).toEqual(['https://cdn.example.com/stream']);
		expect(config.screensaverUrls).toEqual(['https://cdn.example.com/stream']);
		expect(seedMediaDraft([config.videoPlaylist, config.screensaverUrls], 'http://10.0.0.5:3000')).toEqual([
			'https://cdn.example.com/stream'
		]);
	});

	it('does not strip an origin that is not this wall', () => {
		expect(unresolveMediaUrl('https://cdn.example.com/x.mp4', 'http://10.0.0.5:3000')).toBe(
			'https://cdn.example.com/x.mp4'
		);
		// A prefix match alone is not enough: a different host that merely starts
		// with the same characters must survive intact.
		expect(unresolveMediaUrl('http://10.0.0.50:3000/api/media/a.mp3', 'http://10.0.0.5:3000')).toBe(
			'http://10.0.0.50:3000/api/media/a.mp3'
		);
	});

	it('leaves everything alone when the pane polls itself', () => {
		const config = createSettings();
		applyWallState(state({ mediaUrls: ['/api/media/abc123def4567890.mp4'] }), config, 100, '');
		expect(config.videoPlaylist).toEqual(['/api/media/abc123def4567890.mp4']);
	});

	/**
	 * Empty means "keep what the pane booted with". A wall that only ever
	 * changes flight settings must not clobber a URL-provisioned playlist —
	 * otherwise every weather push blanks the media on a pane someone
	 * deliberately configured with ?media=.
	 */
	it('an empty list leaves a boot-provisioned playlist alone', () => {
		const config = createSettings();
		config.videoPlaylist = ['/boot.mp4'];
		config.videoUrl = '/boot.mp4';
		applyWallState(state({ mediaUrls: [] }), config, 100);
		expect(config.videoPlaylist).toEqual(['/boot.mp4']);
		expect(config.videoUrl).toBe('/boot.mp4');
	});

	/**
	 * A pre-upgrade snapshot — buffered across the deploy that added the field —
	 * has no mediaUrls at all. It must apply rather than throw: a schema
	 * addition has to tolerate its own rollout.
	 */
	it('a snapshot from before the field existed still applies', () => {
		const config = createSettings();
		const legacy = state();
		delete (legacy as Partial<WallState>).mediaUrls;
		expect(() => applyWallState(legacy, config, 100)).not.toThrow();
		expect(config.weather).toBe('rain');
	});
});
