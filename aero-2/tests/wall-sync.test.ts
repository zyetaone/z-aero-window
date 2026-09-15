import { describe, it, expect } from 'vitest';
import { WallSync, applyWallState } from '#lib/settings/wall.svelte.js';
import { createSettings } from '#lib/settings/settings.svelte.js';
import type { WallSnapshot, WallState } from '#lib/wall.js';

const state = (over: Partial<WallState> = {}): WallState => ({
	placeId: 'denver',
	presetId: '',
	weather: 'rain',
	clockOffsetH: 3,
	displayMode: 'flight',
	blindOpen: false,
	rotate: false,
	mediaUrls: [],
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

describe('mediaUrls on the receive side', () => {
	it('a push with media fills all three playlist fields', () => {
		const config = createSettings();
		applyWallState(state({ mediaUrls: ['/a.mp4', '/b.mp4'], displayMode: 'video' }), config, 100);
		expect(config.videoPlaylist).toEqual(['/a.mp4', '/b.mp4']);
		expect(config.screensaverUrls).toEqual(['/a.mp4', '/b.mp4']);
		expect(config.videoUrl).toBe('/a.mp4');
		expect(config.videoIndex, 'a new playlist must start at its first track').toBe(0);
		expect(config.displayMode).toBe('video');
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
