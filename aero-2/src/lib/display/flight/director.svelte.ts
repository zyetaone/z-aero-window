/**
 * director.svelte.ts — which destination the window is over, right now.
 *
 * Three Pi 5s stand side by side and exchange nothing, so the destination has
 * to be DERIVED rather than decided. This used to be a state machine: an
 * accumulated `timer`, and an interval rolled from `Math.random()`. Both split
 * the wall, for two independent reasons.
 *
 * The random one is obvious — each pane rolled its own 2-5 minute interval, so
 * within one cycle the three windows sat over three different cities.
 *
 * The accumulator is the subtler one, and seeding the random would not have
 * fixed it. `tick` was fed `Math.min(0.1, delta / 1000)`, so every frame longer
 * than 100 ms silently dropped time. The timer therefore ran slower than the
 * wall clock, by an amount that depends on each pane's frame drops, and reset
 * to zero on reboot. Three panes, three different amounts of lost time.
 *
 * A slot index off the wall clock has neither problem. Every pane computes the
 * same answer from the same second without being told, a pane that reboots
 * rejoins mid-rotation instead of restarting the cycle, and there is no state
 * to drift.
 */

import { LOCATIONS, Location } from '../../settings/locations.js';
import type { PaneSettings } from '../../settings/settings.svelte.js';
import { DWELL_SEC as _DWELL_SEC } from './flight-path.js';

/** Re-exported from `flight-path` — kept so this module's many importers do not churn. */
export const DWELL_SEC = _DWELL_SEC;

/**
 * Which destination the whole wall is over at `wallSec`.
 *
 * Pure, total, and identical on every pane. `rotationSeed` shifts the starting
 * point so the rotation is not the same order every day; it must be the SAME
 * integer on all three panes, which is why it comes from the day rather than
 * from the process.
 */
/** Which rotation slot a wall-clock second falls in. */
function slotOf(wallSec: number): number {
	return Math.floor(Math.max(0, wallSec) / DWELL_SEC);
}

export function destinationAt(wallSec: number, rotationSeed = 0): Location {
	const slot = slotOf(wallSec);
	const index = (((slot + rotationSeed) % LOCATIONS.length) + LOCATIONS.length) % LOCATIONS.length;
	return LOCATIONS[index];
}

/** Whole days since the epoch — the same integer on every pane, all day. */
export function rotationSeedFor(wallSec: number): number {
	return Math.floor(Math.max(0, wallSec) / 86_400);
}

export class FlightDirector {
	private settings: PaneSettings;

	/**
	 * Slots to skip, from an operator pressing "next" on this pane.
	 *
	 * Pane-local and deliberately temporary. A manual advance is one person at
	 * one screen, so it cannot be anything but local — but it expires at the
	 * next slot boundary, and the wall comes back together on its own.
	 *
	 * That last part was a claim, not a behaviour. `manualSkips` only ever went
	 * up, and it is added to the seed on every derivation, so one press of
	 * "next" left this pane permanently one city ahead of the other two — for
	 * the rest of the process's life, on a panorama whose whole premise is that
	 * the three panes show one continuous view. The paragraph describing the
	 * self-healing was written directly above the field that prevented it.
	 *
	 * `skipSlot` is what makes it true: the skips belong to the slot they were
	 * made in, and stop counting when the clock leaves it.
	 */
	manualSkips = $state(0);
	private skipSlot = -1;

	constructor(settings: PaneSettings) {
		this.settings = settings;
	}

	/** Manual skips count only inside the slot they were made in. */
	private skipsAt(wallSec: number): number {
		return slotOf(wallSec) === this.skipSlot ? this.manualSkips : 0;
	}

	/** The destination this pane should be showing at `wallSec`. */
	destinationFor(wallSec: number): Location {
		return destinationAt(wallSec, rotationSeedFor(wallSec) + this.skipsAt(wallSec));
	}

	/**
	 * Move to the derived destination if it has changed.
	 *
	 * Takes wall-clock seconds, NOT a frame delta. Passing `dt` was the bug.
	 */
	tick(wallSec: number): void {
		// The gate reads the setting directly. It used to be an `enabled` $state
		// on this class AND `config.rotate` checked by the caller -- two switches
		// for one behaviour, of which only the settings one was ever written by
		// anything but a test. Asking the settings object is also what makes
		// `?place=` and `?preset=` pin the rotation without telling the director.
		if (!this.settings.rotate) return;
		const next = this.destinationFor(wallSec);
		if (next.id !== this.settings.place.id) this.settings.setPlace(next);
	}

	/**
	 * Operator "next". Goes through setPlace like everything else.
	 *
	 * The previous version assigned `settings.place` directly, which moves the
	 * place and leaves `phase`, `floorM` and `ceilingM` describing
	 * the location you just left — so Mumbai's 500 m floor followed you to
	 * Denver and put the camera inside the Front Range.
	 */
	advanceDestination(wallSec: number): Location {
		const slot = slotOf(wallSec);
		if (slot !== this.skipSlot) {
			this.skipSlot = slot;
			this.manualSkips = 0;
		}
		this.manualSkips += 1;
		const next = this.destinationFor(wallSec);
		this.settings.setPlace(next);
		return next;
	}
}
