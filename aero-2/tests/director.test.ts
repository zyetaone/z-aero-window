import { describe, it, expect } from 'vitest';
import {
	FlightDirector,
	destinationAt,
	rotationSeedFor,
	DWELL_SEC
} from '../src/lib/display/flight/director.svelte.js';
import { createSettings } from '../src/lib/settings/settings.svelte.js';
import { ROTATION } from '../src/lib/settings/locations.js';
import { blindClosedAt, BLIND_LAG_SEC, BLIND_LEAD_SEC } from '../src/lib/display/flight/flight-path.js';

/**
 * These replace tests that asserted `currentDestinationIndex` walked 0, 1, 2.
 * That was true of the old state machine and told us nothing about the only
 * property that matters here: three panes with no link between them must be
 * over the SAME city at the same second.
 */
describe('the destination is derived, not decided', () => {
	it('three independent panes agree at every second', () => {
		const panes = [
			new FlightDirector(createSettings()),
			new FlightDirector(createSettings()),
			new FlightDirector(createSettings())
		];

		// A full day, sampled off the slot grid so boundaries are crossed
		// mid-stride rather than landed on exactly.
		for (let t = 0; t < 86_400; t += 137) {
			const [a, b, c] = panes.map((p) => p.destinationFor(t).id);
			expect(b, `panes diverged at t=${t}`).toBe(a);
			expect(c, `panes diverged at t=${t}`).toBe(a);
		}
	});

	it('holds one destination for a whole dwell and then moves on', () => {
		const seed = rotationSeedFor(0);
		const first = destinationAt(0, seed).id;

		for (let t = 0; t < DWELL_SEC; t += 11) {
			expect(destinationAt(t, seed).id, `changed mid-dwell at t=${t}`).toBe(first);
		}
		expect(destinationAt(DWELL_SEC, seed).id).not.toBe(first);
	});

	it('visits every rotation stop over a full rotation', () => {
		const seed = rotationSeedFor(0);
		const seen = new Set<string>();
		for (let i = 0; i < ROTATION.length; i++) seen.add(destinationAt(i * DWELL_SEC, seed).id);
		expect(seen.size).toBe(ROTATION.length);
	});

	it('drops the blind across every slot boundary and nowhere else', () => {
		for (let slot = 0; slot < 4; slot++) {
			const boundary = slot * DWELL_SEC;
			expect(blindClosedAt(boundary - 1), 'lead').toBe(true);
			expect(blindClosedAt(boundary), 'boundary').toBe(true);
			expect(blindClosedAt(boundary + BLIND_LAG_SEC - 1), 'lag').toBe(true);
			expect(blindClosedAt(boundary + BLIND_LAG_SEC), 'lifted').toBe(false);
			expect(blindClosedAt(boundary + DWELL_SEC / 2), 'mid-slot').toBe(false);
			expect(blindClosedAt(boundary + DWELL_SEC - BLIND_LEAD_SEC - 1), 'before lead').toBe(false);
		}
	});

	/**
	 * A pane that reboots must rejoin the rotation, not restart it. The old
	 * accumulator reset `timer` to 0 on construction, so a restarted pane held
	 * its city for a fresh full interval while the other two moved on.
	 */
	it('a pane constructed mid-rotation lands where the others already are', () => {
		const running = new FlightDirector(createSettings());
		const t = DWELL_SEC * 3.4;
		const rebooted = new FlightDirector(createSettings());
		expect(rebooted.destinationFor(t).id).toBe(running.destinationFor(t).id);
	});

	it('is stable across repeat evaluation of the same second', () => {
		const d = new FlightDirector(createSettings());
		const t = 12_345;
		expect(d.destinationFor(t).id).toBe(d.destinationFor(t).id);
	});
});

describe('the director moves the whole envelope, not just the place', () => {
	/**
	 * The old `advanceDestination` assigned `settings.place` directly. That
	 * moves the place and leaves phase, floorM and ceilingM describing
	 * the location you just left — so Mumbai's 500 m floor could follow you to
	 * Denver and put the camera inside the Front Range.
	 */
	it('carries the climb envelope with the destination', () => {
		const settings = createSettings();
		const director = new FlightDirector(settings);

		// A slot whose stop is not the place the settings start on, else setPlace
		// is rightly skipped and there is no envelope move to observe.
		let slot = 6;
		while (director.destinationFor(DWELL_SEC * slot).id === settings.place.id) slot++;
		const target = director.destinationFor(DWELL_SEC * slot);
		director.tick(DWELL_SEC * slot);

		expect(settings.place.id).toBe(target.id);
		expect(settings.floorM).toBe(target.climbFloorM);
		expect(settings.ceilingM).toBe(target.climbCeilingM);
	});

	it('does nothing when already over the derived destination', () => {
		const settings = createSettings();
		const director = new FlightDirector(settings);
		director.tick(DWELL_SEC * 2);
		const after = settings.place.id;
		director.tick(DWELL_SEC * 2 + 5);
		expect(settings.place.id).toBe(after);
	});

	/**
	 * The gate is `settings.rotate`, and it is the ONLY gate. The director also
	 * carried its own `enabled` flag, which nothing outside this file's own test
	 * ever wrote -- two switches for one behaviour, so an operator turning one
	 * off could be quietly overruled by the other.
	 */
	it('holds the destination when the settings say not to rotate', () => {
		const settings = createSettings();
		settings.rotate = false;
		const director = new FlightDirector(settings);
		const before = settings.place.id;
		director.tick(DWELL_SEC * 5);
		expect(settings.place.id).toBe(before);
	});
});

describe('a manual advance is local and temporary', () => {
	it('moves this pane immediately', () => {
		const settings = createSettings();
		const director = new FlightDirector(settings);
		const before = director.destinationFor(0).id;
		const moved = director.advanceDestination(0);
		expect(moved.id).not.toBe(before);
		expect(settings.place.id).toBe(moved.id);
	});

	/**
	 * The wall heals itself. An operator pressing "next" on one pane cannot be
	 * anything but pane-local, so the design makes it decay instead of
	 * persisting: reset drops the skip and the clock re-derives the answer.
	 */
	it('is dropped by reset, returning the pane to the derived rotation', () => {
		const settings = createSettings();
		const solo = new FlightDirector(settings);
		const wall = new FlightDirector(createSettings());

		solo.advanceDestination(0);
		expect(solo.destinationFor(0).id).not.toBe(wall.destinationFor(0).id);

		/**
		 * And rejoins on its own at the next slot boundary, with nothing reset
		 * and nothing synced -- which is what the class always claimed and did
		 * not do. `manualSkips` only went up and was added to the seed on every
		 * derivation, so one press of "next" left this pane permanently one city
		 * ahead of the other two on a wall that is meant to be one view.
		 */
		expect(solo.destinationFor(DWELL_SEC).id).toBe(wall.destinationFor(DWELL_SEC).id);
	});
});
