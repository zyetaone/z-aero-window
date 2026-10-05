/**
 * Where the window can be, and which city the wall is over right now.
 *
 * The rotation is aero-2's (display/flight/director.svelte.ts), ported as is:
 * each city holds the wall for DWELL_SEC, and the day's order is a Fisher-Yates
 * shuffle seeded by the day number. Three panes that exchange nothing compute
 * the same city from the same wall second. The Himalayas stay out of it, as in
 * aero-2: a catalogue entry for ?place=, not a rotation stop.
 */
import { mulberry32 } from './math.ts';

/** [lat, lon, ground elevation m, orbit radius m (default 9 km)] at each place's pin. */
export const PLACES: Record<string, [number, number, number, number?]> = {
	hyderabad: [17.4435, 78.3772, 500],
	mumbai: [19.076, 72.8777, 10],
	dubai: [25.15, 55.19, 5, 13_000], // between Downtown, the Marina and Palm Jumeirah: one loop takes in all three
	dallas: [32.7767, -96.797, 150],
	phoenix: [33.4352, -112.0101, 340],
	las_vegas: [36.1699, -115.1398, 620],
	denver: [39.8561, -104.6737, 1600],
	chicago_midway: [41.7868, -87.7522, 190],
	himalayas: [27.9881, 86.925, 5000, 24_000] // a wide loop: ridges 8 km tall fill a tight one
};

/** A place id as people read it: 'chicago_midway' -> 'chicago midway'. */
export const placeName = (id: string) => id.replaceAll('_', ' ');

export const DWELL_SEC = 600;

/** Which visit slot a wall-clock second is in: each one is a fresh flight, under the blind. */
export const slotAt = (wallSec: number) => Math.floor(Math.max(0, wallSec) / DWELL_SEC);
const ROTATION = ['hyderabad', 'mumbai', 'dubai', 'dallas', 'phoenix', 'denver', 'las_vegas', 'chicago_midway'];

/** The day's order of the rotation: the same shuffle on every pane, a different one tomorrow. */
function orderFor(day: number) {
	const rand = mulberry32((day * 7919) >>> 0);
	const out = [...ROTATION];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

/** The city the whole wall is over at `wallSec` (Unix seconds). */
export function destinationAt(wallSec: number) {
	const order = orderFor(Math.floor(Math.max(0, wallSec) / 86_400));
	return order[Math.floor(Math.max(0, wallSec) / DWELL_SEC) % order.length]!;
}
