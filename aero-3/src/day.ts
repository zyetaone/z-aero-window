/**
 * Today, for one place: the weather and the light, the same on every pane and
 * different tomorrow. One object, read by the sky, the clouds, the haze and the
 * lights, so a hazy day is hazy everywhere at once.
 *
 * Keyed on the UTC day of the visit's slot start (places.ts), not on the moment
 * a pane booted: three panes that reload a few seconds apart around midnight
 * still agree. `?weather=` pins a regime.
 */
import { hash } from './math.ts';

/**
 * [weight, cover near, cover horizon, cover cirrus, puff size, sun, haze, rain chance].
 * `sun` scales the sunlight (bright to dim days); `haze` scales the air's aerial
 * perspective and the night murk over the city.
 */
const REGIMES: Record<string, [number, number, number, number, number, number, number, number]> = {
	clear: [0.14, 0.1, 0.3, 0.3, 1, 1.05, 0.8, 0],
	fair: [0.28, 0.6, 0.8, 0.6, 0.9, 1, 1, 0],
	scattered: [0.22, 1, 1, 1, 1, 0.95, 1, 0],
	towering: [0.1, 1.3, 1.3, 0.5, 1.35, 0.9, 1.1, 0.4],
	cirrus: [0.08, 0.3, 0.6, 2.5, 1, 0.9, 1.2, 0],
	hazy: [0.11, 0.4, 0.5, 0.8, 1, 0.75, 1.8, 0],
	overcast: [0.07, 1.5, 1.5, 0.3, 1.2, 0.6, 1.4, 1]
};

export type Day = {
	name: string;
	seed: number;
	/** Cluster-count scale per cloud tier: near cumulus, horizon systems, cirrus. */
	cover: [number, number, number];
	size: number;
	/** Sunlight scale: a bright day ~1.05, a dim overcast one ~0.6. */
	sun: number;
	/** Aerial perspective and night murk scale. */
	haze: number;
	/** Rain on the glass today. */
	rain: boolean;
	/** Cloud base above the ground, m, and the wind that carries the deck, m/s. */
	deckM: number;
	wind: number;
	/** Night lights: overall gain. */
	lights: number;
	/** How far near cumulus heap upward: 0 flat-topped, 1 towering. */
	build: number;
	/** How grey the deck runs: 0 bright white, 1 leaden. */
	grey: number;
};

export function dayFor(place: string, ms: number, named?: string | null): Day {
	const day = Math.floor(ms / 86_400_000);
	const seed = Math.floor(hash(day * 0x9e3779b1 + [...place].reduce((h, c) => h * 31 + c.charCodeAt(0), 7)) * 2 ** 31);
	let name = named && Object.hasOwn(REGIMES, named) ? named : '';
	if (!name) {
		let [u, acc] = [hash(seed), 0];
		name = Object.keys(REGIMES).find((k) => u < (acc += REGIMES[k]![0])) ?? 'fair';
	}
	const [, near, far, cirrus, size, sun, haze, rain] = REGIMES[name]!;
	const r = (k: number) => hash(seed + k);
	return {
		name,
		seed,
		cover: [near, far, cirrus],
		size,
		sun,
		haze,
		rain: r(3) < rain,
		deckM: 1_300 + 1_200 * r(4),
		wind: 4 + 10 * r(5),
		lights: 0.85 + 0.3 * r(6),
		build: ({ towering: 1, scattered: 0.4, fair: 0.2 } as Record<string, number>)[name] ?? 0,
		grey: ({ overcast: 0.8, towering: 0.4, hazy: 0.3 } as Record<string, number>)[name] ?? 0.1 * r(7)
	};
}
