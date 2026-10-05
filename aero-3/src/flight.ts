/**
 * The flight: where the aircraft is at a wall-clock second, which way it points,
 * how far it banks, and where the passenger looks. Pure in (seed, second), so
 * three panes fly one aircraft without talking.
 *
 * aero-2's shape (flight-path.ts), in metres around the pin and much simplified:
 * a slightly elliptical orbit whose radius breathes three times a circuit, a
 * slow climb and descent with a little wander, heading and bank read off the
 * path itself, and the gaze panning ±18° over each visit. The seed (one per
 * visit, places.ts) picks the direction, the start angle and the ellipse.
 */
import { hash, noise1, RAD } from './math.ts';
import { DWELL_SEC } from './places.ts';

const SPEED_M_S = 230; // ~450 kt
const CLIMB_M = 350; // the slow altitude swing, either way
const CLIMB_PERIOD_SEC = 2 * DWELL_SEC;
const BANK_GAIN = 0.25; // of the true bank: a 9 km orbit at 450 kt banks ~30°, too steep to watch
const MAX_BANK = 10 * RAD;
const SWEEP = 18 * RAD;
export const SEAT_PITCH = 7 * RAD; // the window looks this far below the horizon; the bank into the turn adds ~8°

export type Pose = { x: number; z: number; climbM: number; heading: number; bank: number; look: number };

export function flight(seed: number, orbitM: number) {
	const dir = hash(seed) < 0.5 ? 1 : -1;
	const [phase, aspect, tilt] = [hash(seed + 1) * 2 * Math.PI, 1 + 0.3 * hash(seed + 2), hash(seed + 3) * Math.PI];
	const [cosT, sinT] = [Math.cos(tilt), Math.sin(tilt)];

	/** Offset from the pin, m (x east, z north). */
	function at(sec: number): [number, number] {
		const theta = phase + (dir * sec * SPEED_M_S) / orbitM;
		const r = orbitM * (1 + 0.06 * Math.sin(3 * theta + phase));
		const [ex, ez] = [r * aspect * Math.cos(theta), r * Math.sin(theta)];
		return [ex * cosT - ez * sinT, ex * sinT + ez * cosT];
	}

	return {
		at,
		/** One full circuit, s: the clearance check walks it once. */
		periodSec: (2 * Math.PI * orbitM) / SPEED_M_S,
		pose(sec: number): Pose {
			const [[x0, z0], [x, z], [x1, z1]] = [at(sec - 1), at(sec), at(sec + 1)];
			const [h0, h1] = [Math.atan2(x - x0, z - z0), Math.atan2(x1 - x, z1 - z)];
			const turn = Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0)); // rad/s, + turning right
			const bank = Math.max(-MAX_BANK, Math.min(MAX_BANK, Math.atan((SPEED_M_S * turn) / 9.81) * BANK_GAIN));
			const climbM = CLIMB_M * Math.sin((2 * Math.PI * sec) / CLIMB_PERIOD_SEC + phase) + 150 * (2 * noise1(seed, sec / 240) - 1);
			// Sit on the inside of the turn, so the window faces the city; the gaze pans over each visit.
			const sweep = SWEEP * Math.cos((2 * Math.PI * (sec % DWELL_SEC)) / DWELL_SEC);
			return { x, z, climbM, heading: Math.atan2(x1 - x0, z1 - z0), bank, look: Math.sign(turn || dir) * 90 * RAD + sweep };
		}
	};
}
