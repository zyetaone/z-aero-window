/**
 * Where the window can be, and which city the wall is over right now.
 *
 * The rotation is aero-2's (display/flight/director.svelte.ts), ported as is:
 * each city holds the wall for DWELL_SEC, and the day's order is a Fisher-Yates
 * shuffle seeded by the day number. Three panes that exchange nothing compute
 * the same city from the same wall second. The Himalayas stay out of it, as in
 * aero-2: a catalogue entry for ?place=, not a rotation stop.
 */
import { mulberry32 } from '#math.ts';

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

/**
 * A place is a composition, not a coordinate (aero-2's PLACE_MOODS, the biases aero-3 has a home
 * for): the painter's choices per city, so the rotation does not look like one city eight times.
 * `glow` scales the night lights, `deckM` moves the cloud base, `cover` scales the cloud count,
 * `dust` thickens the air, `pitchDeg` tips the window (negative looks further down).
 */
export type Mood = { glow: number; deckM: number; cover: number; dust: number; pitchDeg: number };
export const MOODS: Record<string, Partial<Mood>> = {
	hyderabad: { dust: 0.18, pitchDeg: -2 }, // a rocky plateau, lakes, a low sprawl: look down into it
	mumbai: { dust: 0.28, pitchDeg: 1, deckM: -800, cover: 1.2 }, // a monsoon coast: a low grey deck
	dubai: { dust: 0.22, glow: 1.25, pitchDeg: 2, deckM: -500, cover: 0.8 }, // the Palm and the shore, horizon high
	dallas: { dust: 0.15, pitchDeg: -2 }, // a flat grid: ground
	phoenix: { dust: 0.3, glow: 0.9, pitchDeg: -1, deckM: 800, cover: 0.6 }, // a desert basin, high thin cloud
	las_vegas: { dust: 0.2, glow: 1.25, pitchDeg: -1, deckM: 600, cover: 0.6 }, // the Strip, dry air
	denver: { dust: 0.05, deckM: 1200, cover: 0.9 }, // the Front Range under the wing, deck high
	chicago_midway: { dust: 0.08, pitchDeg: 1, deckM: -900, cover: 1.15 }, // the lake: horizon and water, stratus low
	himalayas: { dust: 0, glow: 0.7, pitchDeg: -4, deckM: 3000, cover: 0.9 }
};
export const moodOf = (id: string): Mood => ({ glow: 1, deckM: 0, cover: 1, dust: 0.1, pitchDeg: 0, ...MOODS[id] });

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
