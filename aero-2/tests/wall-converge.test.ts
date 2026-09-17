import { describe, it, expect } from 'vitest';
import { WallSync, applyWallState } from '#lib/settings/wall.svelte.js';
import { PaneSettings } from '#lib/settings/settings.svelte.js';
import type { WallSnapshot, WallState } from '#lib/wall.js';

/**
 * Three Pis, three clocks, one window.
 *
 * ADR-007 replaced v1's CRDT with "convergence by clock": the server stamps
 * `applyAtWallSec` and every pane applies at that instant. The whole argument
 * rests on panes reaching the SAME state from DIFFERENT starting points and
 * different delivery timing, which is a property of the sequence rather than of
 * any one call — so it needs a simulation, not a unit test.
 *
 * NTP on a LAN holds well under a second; the lead is 5 s. These skews are
 * deliberately worse than the field to leave margin.
 */
const snap = (version: number, applyAtWallSec: number, over: Partial<WallState> = {}) =>
	({
		version,
		applyAtWallSec,
		state: {
			placeId: 'denver',
			presetId: '',
			weather: 'clear',
			clockOffsetH: 0,
			displayMode: 'flight',
			blindOpen: true,
			rotate: false,
			mediaUrls: [],
			audioUrls: [],
			...over
		}
	}) satisfies WallSnapshot;

const observed = (c: PaneSettings) =>
	`${c.place.id}|${c.weather}|${c.clockOffsetH}|${c.displayMode}|${c.blindOpen}|${c.rotate}`;

describe('three panes converge', () => {
	it('lands identically despite +/- 400 ms clock skew', () => {
		const panes = [-0.4, 0, 0.4].map((skew) => ({
			skew,
			sync: new WallSync(),
			config: new PaneSettings()
		}));
		const push = snap(1, 1_000_005, { placeId: 'dubai', weather: 'storm' });

		for (const p of panes) p.sync.receive(push);
		// Run every pane through the same wall seconds, each reading its own
		// skewed clock.
		for (let t = 1_000_000; t <= 1_000_010; t++) {
			for (const p of panes) p.sync.applyDue(t + p.skew, p.config);
		}

		const states = panes.map((p) => observed(p.config));
		expect(new Set(states).size, `panes disagree: ${states.join(' vs ')}`).toBe(1);
		expect(panes[0].config.place.id).toBe('dubai');
		expect(panes[0].config.weather).toBe('storm');
	});

	it('ignores a stale snapshot that arrives after a newer one', () => {
		const sync = new WallSync();
		const config = new PaneSettings();

		sync.receive(snap(2, 1_000_005, { placeId: 'mumbai' }));
		// The v1 push was delayed in flight and turns up late. It must not win.
		sync.receive(snap(1, 1_000_005, { placeId: 'phoenix' }));
		for (let t = 1_000_000; t <= 1_000_010; t++) sync.applyDue(t, config);

		expect(config.place.id, 'an older push overwrote a newer one').toBe('mumbai');
	});

	it('applies only the last of several pushes inside the lead window', () => {
		const sync = new WallSync();
		const config = new PaneSettings();

		// Operator changes their mind twice before the first one lands.
		sync.receive(snap(1, 1_000_005, { placeId: 'dubai' }));
		sync.receive(snap(2, 1_000_006, { placeId: 'mumbai' }));
		sync.receive(snap(3, 1_000_007, { placeId: 'denver', weather: 'rain' }));

		for (let t = 1_000_000; t <= 1_000_012; t++) sync.applyDue(t, config);
		expect(config.place.id).toBe('denver');
		expect(config.weather).toBe('rain');
	});

	it('does not apply early, even on the fastest pane', () => {
		const sync = new WallSync();
		const config = new PaneSettings();
		const before = observed(config);

		sync.receive(snap(1, 1_000_005, { placeId: 'dubai', weather: 'storm' }));
		// A pane whose clock runs 0.9 s fast still must not jump the instant.
		for (let t = 1_000_000; t <= 1_000_004; t++) sync.applyDue(t + 0.9, config);
		expect(observed(config), 'a pane applied before its instant').toBe(before);

		sync.applyDue(1_000_005, config);
		expect(config.place.id).toBe('dubai');
	});

	it('a pane that joins late still converges on the next push', () => {
		const early = { sync: new WallSync(), config: new PaneSettings() };
		const late = { sync: new WallSync(), config: new PaneSettings() };

		early.sync.receive(snap(1, 1_000_005, { placeId: 'dubai' }));
		for (let t = 1_000_000; t <= 1_000_010; t++) early.sync.applyDue(t, early.config);

		// `late` booted after that push and never saw it — it is out of step.
		expect(observed(late.config)).not.toBe(observed(early.config));

		// The next push reaches both, and that is what re-synchronises the wall.
		const next = snap(2, 1_000_020, { placeId: 'mumbai', weather: 'cloudy' });
		for (const p of [early, late]) {
			p.sync.receive(next);
			for (let t = 1_000_015; t <= 1_000_025; t++) p.sync.applyDue(t, p.config);
		}
		expect(observed(late.config)).toBe(observed(early.config));
	});
});

/**
 * A preset pushed to the wall must arrive WITH its clock.
 *
 * `applyPreset` does not trust an authored hour: it solves
 * `localHourAtSunElevation` against `wallSec`, because "golden hour" is a sun
 * angle and the hour that produces it moves ~3 h across the year. Only the
 * pane knows `wallSec` at apply time.
 *
 * `applyWallState` then assigned `config.clockOffsetH = state.clockOffsetH`
 * one line later, throwing the solve away. The operator panel seeds that field
 * once at load and no effect recomputes it when a preset is picked, so the
 * "explicit" value that won was never explicit — it was whatever the panel
 * booted with. Every preset pushed to the wall rendered at the wrong hour.
 */
describe('a pushed preset keeps the clock it solved for', () => {
	const WALL = 1_757_700_000;

	it('ignores the snapshot clock when a preset is named', () => {
		const config = new PaneSettings();
		const solo = new PaneSettings();
		solo.applyPreset('golden-hour', WALL);

		applyWallState(
			{
				placeId: '',
				presetId: 'golden-hour',
				weather: 'clear',
				clockOffsetH: 7.25, // stale panel literal, nothing to do with the preset
				displayMode: 'flight',
				blindOpen: true,
				rotate: false,
				mediaUrls: [],
				audioUrls: []
			},
			config,
			WALL
		);

		expect(config.clockOffsetH, 'the stale literal won').toBe(solo.clockOffsetH);
		expect(config.clockOffsetH).not.toBe(7.25);
	});

	it('still honours an explicit clock when no preset is named', () => {
		const config = new PaneSettings();
		applyWallState(
			{
				placeId: 'denver',
				presetId: '',
				weather: 'clear',
				clockOffsetH: 7.25,
				displayMode: 'flight',
				blindOpen: true,
				rotate: false,
				mediaUrls: [],
				audioUrls: []
			},
			config,
			WALL
		);
		expect(config.clockOffsetH).toBe(7.25);
		expect(config.place.id).toBe('denver');
	});
});
