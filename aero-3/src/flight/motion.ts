/**
 * The ride: what the airframe does under the seat, on top of the path. Rough air as a few slow
 * noise streams in pitch, roll and heave, a bump now and then that rings down, and the cabin's
 * long breathing. aero-1's motion model (flight/motion.svelte.ts), made pure in (seed, wall
 * second): aero-1 rolled each bump's sign per pane, which a flat CSS pane could afford; three
 * panes here must bump on one second with one sign, so every draw is hashed off the visit seed
 * and the wall clock. Amplitudes are radians and metres on the aircraft, not aero-1's pixels.
 */
import { hash, noise1, RAD, smoothstep } from '#math.ts';

const PITCH = 0.35 * RAD;
const ROLL = 0.5 * RAD;
const HEAVE_M = 4;
const BREATH = 0.08 * RAD; // the slow 22 s swell, even in still air
const BREATH_SEC = 22;
const BUMP_WINDOW_SEC = 12; // one chance of a bump per window
const BUMP_RATE = 0.3; // of windows, at turbulence 1
const BUMP = 0.9 * RAD;
const BUMP_SEC = 1.5; // a bump rings this long

export type Ride = { pitch: number; roll: number; heaveM: number };

/**
 * The airframe at `sec`: `turbulence` is today's (weather.ts, 0.6 clear to 2 storm), thinned to a
 * fifth above 12 km where the air is still. All three outputs are zero-mean and bounded.
 */
export function rideAt(seed: number, sec: number, turbulence: number, altM: number): Ride {
	const g = turbulence * (1 - 0.8 * smoothstep(8_000, 12_000, altM));
	const n = (k: number, hz: number) => 2 * noise1(seed + k, sec * hz) - 1;
	// Three octaves each, slow to quick, so the air reads as air and not as a sine.
	const pitch = PITCH * g * (0.6 * n(1, 0.12) + 0.3 * n(2, 0.37) + 0.1 * n(3, 1.1));
	const roll = ROLL * g * (0.6 * n(4, 0.09) + 0.3 * n(5, 0.31) + 0.1 * n(6, 0.9));
	const heaveM = HEAVE_M * g * (0.7 * n(7, 0.15) + 0.3 * n(8, 0.5));
	// A bump: in some windows, starting somewhere inside the window, a rung-down ring with a sharp onset.
	const w = Math.floor(sec / BUMP_WINDOW_SEC);
	const roll3 = hash(seed ^ Math.imul(w, 0x27d4eb2d));
	const t = sec - w * BUMP_WINDOW_SEC - hash(seed + w) * (BUMP_WINDOW_SEC - BUMP_SEC);
	const bump = roll3 < BUMP_RATE * g && t >= 0 && t < BUMP_SEC ? (roll3 < BUMP_RATE * g * 0.5 ? 1 : -1) * BUMP * g * Math.exp(-3 * t) * Math.sin(14 * t) * (1 - Math.exp(-8 * t)) : 0;
	return {
		pitch: pitch + bump + BREATH * Math.sin((2 * Math.PI * sec) / BREATH_SEC),
		roll: roll + 0.4 * bump,
		heaveM: heaveM + (bump / BUMP) * HEAVE_M
	};
}
