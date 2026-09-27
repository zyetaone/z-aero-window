/**
 * Autopilot leader/follower lock-step regression coverage.
 *
 * 1. A group leader (center) that broadcasts an autopilot director_decision
 *    must schedule its OWN flyTo at the broadcast transitionAtMs — the fleet
 *    client schedules followers' applyScene at that instant, so a leader that
 *    cruises immediately reopens its blinds ~TRANSITION_DELAY_MS ahead of the
 *    edge panes.
 * 2. A solo leader has no followers: nothing is broadcast, so the autopilot
 *    flies immediately — scheduling would only add a dead 2.5 s delay. The
 *    fleet hook is deliberately still wired (production sets it for solo too,
 *    see +page.svelte) to pin that the gate is "followers exist", not "hook
 *    set".
 * 3. The autopilot's weather roll must not arm the 8 s
 *    userAdjustingAtmosphere override — that override exists to gate the
 *    randomiser while a HUMAN is adjusting, and the roll IS the randomiser.
 * 4. The leader's periodic ambient jitter (tickRandomize) must reach followers.
 *    Followers never run the randomiser — directorTick returns early for them —
 *    so a leader that only applies it locally leaves the 3-screen wall showing
 *    different cloud density/haze until the next location change resyncs it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AeroWindow } from '$lib/model/aero-window.svelte';
import { applyConfigPatch } from '$lib/model/config-tree.svelte';
import { TRANSITION_DELAY_MS } from '$lib/fleet/protocol';
import type { WeatherType } from '$lib/types';

/**
 * One 100 ms frame on the WALL clock. The model's context builder derives
 * wallDeltaSec from Date.now(), and no fallback to the sim delta exists any
 * more, so under fake timers the clock must actually move or nothing
 * time-based advances. setSystemTime rather than advanceTimersByTime: this
 * moves the clock without firing the scheduled cruise timer under test.
 */
function tick100(model: AeroWindow): void {
	vi.setSystemTime(Date.now() + 100);
	model.tick(0.1);
}

// Shrink every autopilot cadence into tick range (model.tick rejects
// delta > 0.1, so intervals must fire within a handful of 0.1 s ticks).
const FAST = {
	'director.autopilot.initialMinDelay': 0.05,
	'director.autopilot.initialMaxDelay': 0.05,
	'director.autopilot.subsequentMinDelay': 0.05,
	'director.autopilot.subsequentMaxDelay': 0.05,
	'director.autopilot.directorMinInterval': 0.05,
	'director.autopilot.directorMaxInterval': 0.05,
} as const;

const DEFAULTS = {
	'director.autopilot.initialMinDelay': 120,
	'director.autopilot.initialMaxDelay': 300,
	'director.autopilot.subsequentMinDelay': 180,
	'director.autopilot.subsequentMaxDelay': 480,
	'director.autopilot.directorMinInterval': 240,
	'director.autopilot.directorMaxInterval': 360,
	'director.autopilot.weatherChangeChance': 0.2,
} as const;

describe('AeroWindow autopilot leader lock-step', () => {
	let model: AeroWindow;
	let broadcasts: Array<Record<string, unknown>>;

	beforeEach(() => {
		vi.useFakeTimers();
		applyConfigPatch('camera.parallax.role', 'solo');
		for (const [path, value] of Object.entries(FAST)) applyConfigPatch(path, value);
		model = new AeroWindow();
		// Pin to midday: no vantage beats, no real-time clock drift.
		model.syncToRealTime = false;
		model.timeOfDay = 12;
		broadcasts = [];
		model.setFleetBroadcast((msg) => {
			broadcasts.push(msg as Record<string, unknown>);
		});
	});

	afterEach(() => {
		model.setFleetBroadcast(null);
		model.destroy();   // cancels any pending lock-step cruise timer
		applyConfigPatch('camera.parallax.role', 'solo');
		for (const [path, value] of Object.entries(DEFAULTS)) applyConfigPatch(path, value);
		vi.useRealTimers();
	});

	it('group leader (center) schedules its own cruise at transitionAtMs, not immediately', () => {
		applyConfigPatch('camera.parallax.role', 'center');
		applyConfigPatch('director.autopilot.weatherChangeChance', 0);
		const flySpy = vi.spyOn(model.flight, 'flyTo');

		// Tick until the director fires (its timers lazy-seed on the first tick).
		// Select the decision by type rather than by position: a leader also
		// broadcasts `set_config` for the autopilot's ambient jitter, and that
		// is emitted FIRST (directorPatch.configs is applied before
		// nextLocation), so broadcasts[0] is not necessarily the decision.
		let guard = 0;
		const decisions = () => broadcasts.filter((b) => b.type === 'director_decision');
		while (decisions().length === 0 && guard++ < 20) tick100(model);

		expect(decisions()).toHaveLength(1);
		const decision = decisions()[0];
		expect(decision.scenarioId).toBe('autopilot');
		const transitionAtMs = decision.transitionAtMs as number;
		expect(transitionAtMs).toBeGreaterThan(Date.now());
		expect(transitionAtMs - Date.now()).toBeLessThanOrEqual(TRANSITION_DELAY_MS);

		// The leader must NOT cruise before the shared wall-clock instant.
		expect(flySpy).not.toHaveBeenCalled();
		expect(model.flight.flightMode).toBe('orbit');

		vi.advanceTimersByTime(transitionAtMs - Date.now() + 1);
		expect(flySpy).toHaveBeenCalledTimes(1);
		expect(model.flight.flightMode).not.toBe('orbit');
	});

	it('group leader broadcasts its ambient jitter so followers do not drift', () => {
		applyConfigPatch('camera.parallax.role', 'center');
		applyConfigPatch('director.autopilot.weatherChangeChance', 0);

		let guard = 0;
		const ambient = () => broadcasts.filter((b) => b.type === 'set_config');
		while (ambient().length === 0 && guard++ < 20) tick100(model);

		expect(ambient().length).toBeGreaterThan(0);
		// All three values tickRandomize rolls must travel together — sending
		// density without speed/haze would leave the panes partly diverged.
		const patch = ambient()[0].patch as Record<string, unknown>;
		expect(typeof patch.cloudDensity).toBe('number');
		expect(typeof patch.cloudSpeed).toBe('number');
		expect(typeof patch.hazeAmount).toBe('number');
	});

	it('solo broadcasts no ambient jitter — there are no followers to sync', () => {
		expect(model.config.camera.parallax.role).toBe('solo');
		let guard = 0;
		while (guard++ < 20) tick100(model);
		expect(broadcasts.filter((b) => b.type === 'set_config')).toHaveLength(0);
	});

	it('solo autopilot flies immediately — no followers, nothing broadcast', () => {
		// Role stays 'solo' with the fleet hook wired (as production does):
		// the gate is "followers exist" (center), not "hook set".
		expect(model.config.camera.parallax.role).toBe('solo');
		applyConfigPatch('director.autopilot.weatherChangeChance', 0);
		const flySpy = vi.spyOn(model.flight, 'flyTo');

		let guard = 0;
		while (flySpy.mock.calls.length === 0 && guard++ < 20) tick100(model);

		expect(flySpy).toHaveBeenCalledTimes(1);   // flew inside the tick…
		expect(broadcasts).toHaveLength(0);        // …with nothing on the wire
		expect(model.flight.flightMode).not.toBe('orbit');
	});

	it('autopilot weather roll does not arm userAdjustingAtmosphere', () => {
		applyConfigPatch('director.autopilot.weatherChangeChance', 1);
		applyConfigPatch('director.autopilot.weatherPool', ['clear']);
		model.weather = 'rain' as WeatherType;   // force a visible change on the roll
		expect(model.userAdjustingAtmosphere).toBe(false);

		let guard = 0;
		while (model.weather !== 'clear' && guard++ < 20) tick100(model);

		expect(model.weather).toBe('clear');            // the roll landed…
		expect(model.userAdjustingAtmosphere).toBe(false); // …without masquerading as a user
	});

	// Contrast: the HUMAN path must keep arming the override. Runs last —
	// the module-level override timestamps outlive a single test.
	it('manual setWeather still arms the user override', () => {
		model.setWeather('rain');
		expect(model.userAdjustingAtmosphere).toBe(true);
	});
});
