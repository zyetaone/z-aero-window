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

/** How the near and mid clouds are arranged: anywhere, in rows along the wind, massed on one side, in a few groups. */
export type Layout = 'scatter' | 'streets' | 'front' | 'clumps';

type Regime = {
	weight: number;
	/** Cluster-count scale per tier: near cumulus, horizon systems, cirrus. */
	cover: [near: number, far: number, cirrus: number];
	size: number;
	sun: number;
	haze: number;
	rain: number;
	/** Final-image contrast: a crisp clear day snaps, a hazy one is flat. */
	contrast: number;
	/** Mie (aerosol) scattering scale: low is a deep blue sky to the horizon, high a milky white one. */
	mie: number;
	/** Cloud arrangements this regime allows, picked per day. */
	layouts: Layout[];
};

const ALL: Layout[] = ['scatter', 'streets', 'front', 'clumps'];
const REGIMES: Record<string, Regime> = {
	clear: { weight: 0.14, cover: [0.1, 0.3, 0.3], size: 1, sun: 1.05, haze: 0.7, rain: 0, contrast: 1.22, mie: 0.45, layouts: ['scatter'] },
	fair: { weight: 0.28, cover: [0.6, 0.8, 0.6], size: 0.9, sun: 1, haze: 0.9, rain: 0, contrast: 1.15, mie: 0.6, layouts: ALL },
	scattered: { weight: 0.22, cover: [1, 1, 1], size: 1, sun: 0.95, haze: 1, rain: 0, contrast: 1.1, mie: 0.75, layouts: ALL },
	towering: { weight: 0.1, cover: [1.3, 1.3, 0.5], size: 1.35, sun: 0.9, haze: 1.1, rain: 0.4, contrast: 1.2, mie: 0.8, layouts: ['scatter', 'front', 'clumps'] },
	cirrus: { weight: 0.08, cover: [0.3, 0.6, 2.5], size: 1, sun: 0.9, haze: 1.2, rain: 0, contrast: 1.05, mie: 1, layouts: ['scatter', 'streets'] },
	hazy: { weight: 0.11, cover: [0.4, 0.5, 0.8], size: 1, sun: 0.75, haze: 1.8, rain: 0, contrast: 0.95, mie: 2, layouts: ['scatter'] },
	overcast: { weight: 0.07, cover: [1.5, 1.5, 0.3], size: 1.2, sun: 0.6, haze: 1.4, rain: 1, contrast: 1, mie: 1.6, layouts: ['scatter'] }
};

export const REGIME_NAMES = Object.keys(REGIMES);

export type Day = Omit<Regime, 'weight' | 'rain' | 'layouts'> & {
	name: string;
	seed: number;
	/** Rain on the glass today. */
	rain: boolean;
	layout: Layout;
	/** Cloud base above the ground, m, and the wind that carries the deck, m/s, toward `windDir` (rad). */
	deckM: number;
	wind: number;
	windDir: number;
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
	const r = (k: number) => hash(seed + k);
	let name = named && Object.hasOwn(REGIMES, named) ? named : '';
	if (!name) {
		let acc = 0;
		name = REGIME_NAMES.find((k) => r(0) < (acc += REGIMES[k]!.weight)) ?? 'fair';
	}
	const { weight: _, rain, layouts, ...regime } = REGIMES[name]!;
	return {
		...regime,
		name,
		seed,
		// A little of each day's own: never the same punch or the same blue twice.
		contrast: regime.contrast + 0.08 * (r(8) - 0.5),
		mie: regime.mie * (0.85 + 0.3 * r(9)),
		rain: r(3) < rain,
		layout: layouts[Math.floor(r(10) * layouts.length)]!,
		deckM: 1_300 + 1_200 * r(4),
		wind: 4 + 10 * r(5),
		windDir: 2 * Math.PI * r(11),
		lights: 0.85 + 0.3 * r(6),
		build: ({ towering: 1, scattered: 0.4, fair: 0.2 } as Record<string, number>)[name] ?? 0,
		grey: ({ overcast: 0.8, towering: 0.4, hazy: 0.3 } as Record<string, number>)[name] ?? 0.1 * r(7)
	};
}
