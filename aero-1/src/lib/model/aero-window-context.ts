/**
 * Per-frame SimulationContext assembly for AeroWindow.
 *
 * ─── On the name `tick` ─────────────────────────────────────────────────────
 * Svelte exports a `tick()` too, and it is an unrelated thing: it returns a
 * promise that resolves once pending state changes have been flushed to the
 * DOM. Ours is a simulation step driven by requestAnimationFrame (see
 * game-loop.ts) — synchronous, takes a delta, advances the world. They are not
 * interchangeable in either direction, and nothing in this repo imports
 * Svelte's. Note that GlobeLayer wraps the call in `untrack()` so a simulation
 * step never registers reactive dependencies and re-entrantly schedules itself.
 *
 * ─── What lives here, and what deliberately does not ────────────────────────
 * Only the marshalling: model fields → the context object that flight, motion
 * and director all read. That is ~60 lines of mechanical copying wrapped
 * around two pieces of genuinely subtle clock handling, and it is pure — no
 * `$state` writes, no fleet calls — so it tests without a model.
 *
 * `tick()` itself stays on the class. It is the update ORDER (flight → motion
 * → director) plus the application of each patch, which touches reactive
 * fields, the fleet broadcast and the scene timers. Extracting it would mean a
 * host interface of twenty-odd members reproducing most of AeroWindow, which
 * buys nothing: an update order is exactly the kind of thing that belongs at
 * the top level where you can read it in sequence.
 */
import type { SimulationContext } from '$lib/types';
import { WEATHER_EFFECTS } from '$content/weather';

/** Ceiling on a single frame's wall-clock gap, seconds. */
const MAX_WALL_DELTA_SEC = 5;

/**
 * Wall-clock gap between frames, in seconds, clamped at both ends.
 *
 * Both bounds are load-bearing and both come from real failure modes:
 *
 * - CAPPED at 5 s because a backgrounded tab (or a Pi whose compositor stalls)
 *   resumes with an arbitrarily large gap, and the consumers are integrators —
 *   orbitAngle and scenarioProgress would teleport on wake.
 * - FLOORED at 0 because a runtime NTP step BACKWARD makes `now - last`
 *   negative, and a −3600 s delta does not just pause those integrators, it
 *   drives them far negative and parks the scenario accumulator in a long
 *   recovery. The fleet runs NTP on hardware with no RTC, so a step-back at
 *   boot is ordinary rather than exotic.
 *
 * `lastMs === 0` means "first frame" — no previous instant to measure from, so
 * the honest answer is 0 rather than the epoch.
 */
export function wallDeltaSec(nowMs: number, lastMs: number): number {
	if (lastMs === 0) return 0;
	if (!Number.isFinite(nowMs) || !Number.isFinite(lastMs)) return 0;
	return Math.min(Math.max((nowMs - lastMs) / 1000, 0), MAX_WALL_DELTA_SEC);
}

/** The model fields a frame's context is assembled from. */
export interface ContextSource {
	readonly flight: {
		lat: number; lon: number; altitude: number; heading: number;
		pitch: number; warpFactor: number;
	};
	readonly motion: { bankAngle: number };
	readonly weather: SimulationContext['weather'];
	readonly skyState: SimulationContext['skyState'];
	readonly nightFactor: number;
	readonly dawnDuskFactor: number;
	readonly location: SimulationContext['locationId'];
	readonly userAdjustingAltitude: boolean;
	readonly userAdjustingTime: boolean;
	readonly userAdjustingAtmosphere: boolean;
	readonly config: {
		atmosphere: { clouds: { density: number; speed: number }; haze: { amount: number } };
	};
}

/**
 * Owns the reused context object and the wall-clock cursor.
 *
 * The context is mutated in place and handed out by reference every frame,
 * on purpose: allocating a fresh one at 60 Hz on a Pi is measurable GC
 * pressure for no benefit, since every consumer reads it synchronously within
 * the same frame and none retains it.
 */
export class SimulationContextBuilder {
	#lastWallMs = 0;

	readonly #ctx: SimulationContext;

	constructor(seed: Pick<SimulationContext, 'camera' | 'director'>) {
		this.#ctx = {
			wallTimeSec: 0, wallDeltaSec: 0, lat: 0, lon: 0, altitude: 0, heading: 0, pitch: 0, bankAngle: 0,
			weather: 'cloudy', skyState: 'day', nightFactor: 0, dawnDuskFactor: 0,
			locationId: 'hyderabad', userAdjustingAltitude: false, userAdjustingTime: false,
			userAdjustingAtmosphere: false, cloudDensity: 0, cloudSpeed: 0, haze: 0,
			warpFactor: 0,
			turbulenceLevel: 'light',
			camera: seed.camera,
			director: seed.director,
		} as SimulationContext;
	}

	/**
	 * Refresh and return the shared context. `nowMs` is injectable for tests.
	 *
	 * There is no `timeSec` parameter and no `c.time` write. The context used to
	 * carry a second, boot-relative clock beside the wall one, fed by the
	 * game-loop's dt-clamped delta — so it ran 0.2-0.4x the wall rate on the
	 * 2-4 fps a Pi actually achieves, and its single live reader (motion's
	 * oscillator phases) put the panes' cabin breathing out of phase. With that
	 * reader migrated to `wallTimeSec` the field had none, so the whole
	 * accumulator is gone rather than left writing a value nothing reads.
	 * See the note on SimulationContext.wallTimeSec in types.ts.
	 */
	build(src: ContextSource, nowMs: number = Date.now()): SimulationContext {
		const c = this.#ctx;
		c.wallTimeSec = nowMs / 1000;
		c.wallDeltaSec = wallDeltaSec(nowMs, this.#lastWallMs);
		this.#lastWallMs = nowMs;

		c.lat = src.flight.lat;
		c.lon = src.flight.lon;
		c.altitude = src.flight.altitude;
		c.heading = src.flight.heading;
		c.pitch = src.flight.pitch;
		c.warpFactor = src.flight.warpFactor;
		c.bankAngle = src.motion.bankAngle;

		c.weather = src.weather;
		c.skyState = src.skyState;
		c.nightFactor = src.nightFactor;
		c.dawnDuskFactor = src.dawnDuskFactor;
		c.locationId = src.location;

		c.userAdjustingAltitude = src.userAdjustingAltitude;
		c.userAdjustingTime = src.userAdjustingTime;
		c.userAdjustingAtmosphere = src.userAdjustingAtmosphere;

		c.cloudDensity = src.config.atmosphere.clouds.density;
		c.cloudSpeed = src.config.atmosphere.clouds.speed;
		c.haze = src.config.atmosphere.haze.amount;

		c.turbulenceLevel = WEATHER_EFFECTS[src.weather].turbulence;
		return c;
	}
}
