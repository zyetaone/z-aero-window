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
