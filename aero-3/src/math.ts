/** The small numeric helpers every module shares: angles, easing and seeded noise. */

export const RAD = Math.PI / 180;

export const smoothstep = (a: number, b: number, x: number) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

/** Integer hash to [0, 1) (lowbias32, public domain): seeded noise without a PRNG's state. */
export function hash(n: number) {
	n ^= n >>> 16;
	n = Math.imul(n, 0x7feb352d);
	n ^= n >>> 15;
	n = Math.imul(n, 0x846ca68b);
	n ^= n >>> 16;
	return (n >>> 0) / 4294967296;
}

/** Seeded PRNG (Tommy Ettinger's mulberry32, public domain): every pane builds the same city. */
export function mulberry32(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Smooth 1D value noise in [0, 1): hashed lattice values eased between, one stream per seed. */
export function noise1(seed: number, x: number) {
	const i = Math.floor(x);
	const t = x - i;
	const [a, b] = [hash(seed ^ Math.imul(i, 0x27d4eb2d)), hash(seed ^ Math.imul(i + 1, 0x27d4eb2d))];
	return a + (b - a) * t * t * (3 - 2 * t);
}

/** Smooth 2D value noise in [0, 1). */
export function noise2(seed: number, x: number, y: number) {
	const [i, j] = [Math.floor(x), Math.floor(y)];
	const [u, v] = [x - i, y - j].map((t) => t * t * (3 - 2 * t)) as [number, number];
	const at = (a: number, b: number) => hash(seed ^ Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1));
	const [top, bottom] = [at(i, j) + (at(i + 1, j) - at(i, j)) * u, at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * u];
	return top + (bottom - top) * v;
}

/** Fractal value noise: `octaves` layers, each twice the frequency and half the weight. */
export function fbm(seed: number, x: number, y: number, octaves = 4) {
	let [sum, weight, total] = [0, 0.5, 0];
	for (let o = 0; o < octaves; o++, x *= 2, y *= 2, weight /= 2) {
		sum += noise2(seed + o, x, y) * weight;
		total += weight;
	}
	return sum / total;
}
