/**
 * The ground's baked maps: pure canvas-to-canvas work done once at boot, out of
 * the tiles ground/terrain.ts fetches. Night ground (VIIRS x imagery x roads x noise), the
 * light dome for the haze, the water roughness mask, far-ring town lights, the
 * imagery crop trees sample, roads painted into the imagery, and the tiling detail
 * map. No mesh, no scene state: each takes canvases and returns one.
 */
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { Scene } from '@babylonjs/core/scene';
import { fbm, hash, noise2, smoothstep } from '../math.ts';
import { mercX, mercY, TILE, type Grid } from './mercator.ts';

/** One OSM road from a place's pack: painted into the ground by day (paintRoads), lamps along it by night (city/lights.ts). */
export type Road = { geometry: { coordinates: number[][] }; properties: { class: string } };

/** Carriageway widths in metres, drawn narrow to wide so motorways land on top. */
const ROAD_M: [cls: string, metres: number][] = [['residential', 8], ['tertiary', 11], ['secondary', 15], ['primary', 20], ['trunk', 26], ['motorway', 32]];

const GLOW = 0.12; // NASA's radiance as a faint carpet: the points carry the detail
const REVEAL = 0.3; // how much of the real ground a lit district shows at night
const ROAD_GLOW = 0.35; // sodium on the asphalt of a lit district's streets
const CROP_M = 9_000; // imagery kept for sampling (ground/trees.ts, which plant within 9 km), either side of the pin

/**
 * The night ground, once at boot, from NASA's VIIRS radiance: aero-2's
 * luminance knee at 0.35..0.75 (raw VIIRS over a city is mid-bright almost
 * everywhere, and anything lower pastes a cream sheet over it) as a faint amber
 * glow, and the same radiance as a mask that lets the real imagery show through
 * warm where a district is lit — streets, roofs and parks read under the lamps
 * instead of a flat orange; and `roads` (a white mask) glows sodium where that radiance is,
 * broken by noise. `lights` is rewritten in place and returned.
 */
export function nightGround(lights: OffscreenCanvas, imagery: OffscreenCanvas, roads: OffscreenCanvas | null) {
	const ctx = lights.getContext('2d')!;
	const image = ctx.getImageData(0, 0, lights.width, lights.height);
	const [d, ground] = [image.data, imagery.getContext('2d')!.getImageData(0, 0, imagery.width, imagery.height).data];
	const road = roads?.getContext('2d')!.getImageData(0, 0, roads.width, roads.height).data;
	const width = lights.width;
	for (let i = 0; i < d.length; i += 4) {
		const t = Math.max(d[i]!, d[i + 1]!, d[i + 2]!) / 255;
		if (t < 0.3) {
			d[i] = d[i + 1] = d[i + 2] = 0; // most of the map is dark: skip the maths
			continue;
		}
		const k = smoothstep(0.35, 0.75, t) * (0.25 + 0.6 * t * t) * GLOW;
		const lit = smoothstep(0.3, 0.8, t) * REVEAL;
		// Lit streets: the road mask, where NASA saw light, broken by ~430 m noise so a district's
		// streets glow in patches the way sodium pools do, not as an even orange web.
		const px = i / 4;
		const r = road && road[i + 3]! > 0 ? (road[i + 3]! / 255) * smoothstep(0.3, 0.6, t) * smoothstep(0.3, 0.65, noise2(0x5d, (px % width) / 12, Math.floor(px / width) / 12)) * ROAD_GLOW : 0;
		d[i] = 255 * (k + r) + ground[i]! * lit;
		d[i + 1] = 150 * k + 165 * r + ground[i + 1]! * lit * 0.8;
		d[i + 2] = 60 * k + 70 * r + ground[i + 2]! * lit * 0.6;
	}
	ctx.putImageData(image, 0, 0);
	return lights;
}

/**
 * The light a city throws up into the haze above it, as a 256² map over the
 * near patch: NASA's radiance blurred by downsampling (each step averages) into
 * a soft dome, then multiplied by fractal noise so it reads as uneven haze and
 * not a smooth disc. Composed from the map, textured by generated noise.
 */
export function lightDome(lights: OffscreenCanvas) {
	let src: OffscreenCanvas = lights;
	for (const side of [768, 192, 64]) {
		const step = new OffscreenCanvas(side, side);
		step.getContext('2d')!.drawImage(src, 0, 0, side, side);
		src = step;
	}
	const dome = new OffscreenCanvas(256, 256);
	const ctx = dome.getContext('2d')!;
	ctx.drawImage(src, 0, 0, 256, 256); // back up, bilinear: the blur
	const image = ctx.getImageData(0, 0, 256, 256);
	const d = image.data;
	for (let i = 0; i < d.length; i += 4) {
		const [x, y] = [(i / 4) % 256, Math.floor(i / 4 / 256)];
		// The ground's knee: averaged VIIRS is mid-bright almost everywhere, so only the city domes.
		const t = smoothstep(0.35, 0.75, Math.max(d[i]!, d[i + 1]!, d[i + 2]!) / 255);
		const k = t * (0.45 + 0.9 * fbm(0x4a2e, x / 24, y / 24));
		[d[i], d[i + 1], d[i + 2]] = [255 * k, 165 * k, 90 * k];
	}
	ctx.putImageData(image, 0, 0);
	return dome;
}

/**
 * Water as a metallic-roughness map (G roughness, B metal = 0): dark,
 * green-or-teal Sentinel-2 pixels read as water and get roughness ~0.12, land 1.
 * A soft edge keeps shores from aliasing into a hard outline.
 */
export function waterMask(imagery: OffscreenCanvas) {
	const { width, height } = imagery;
	const src = imagery.getContext('2d')!.getImageData(0, 0, width, height).data;
	const mask = new OffscreenCanvas(width, height);
	const ctx = mask.getContext('2d')!;
	const out = ctx.createImageData(width, height);
	for (let i = 0; i < src.length; i += 4) {
		const [r, g, b] = [src[i]!, src[i + 1]!, src[i + 2]!];
		// Measured: lakes (50,59,38) (89,103,77), sea (69,101,98) (31,96,102); dry land and city
		// run red-over-green, canopy runs blue under ~0.55 of green. Some dark canopy still passes.
		const water = smoothstep(320, 230, r + g + b) * smoothstep(-2, 8, g - r) * smoothstep(0.55, 0.68, b / (g + 1));
		// Wind on the water: fractal noise in the roughness (~0.5 km cells), so the sun's glint
		// breaks into ruffled patches and calm slicks instead of one mirror. Water pixels only.
		const ruffle = water > 0.01 ? 0.55 + 0.9 * fbm(0x3a7e5, ((i / 4) % width) / 14, Math.floor(i / 4 / width) / 14, 3) : 1;
		out.data[i + 1] = 255 * (1 - 0.88 * water * Math.min(1, 1.25 - 0.5 * ruffle));
		out.data[i + 3] = 255;
	}
	ctx.putImageData(out, 0, 0);
	return mask;
}

/**
 * Towns beyond the road pack, from NASA's radiance: each bright far-ring pixel
 * (~600 m) becomes a cluster of up to three lights, more the brighter it is,
 * jittered inside the pixel by hash so every pane places the same ones. Derived
 * from the map, not invented, and only where the road pack has no points.
 */
export function lightSites(lights: OffscreenCanvas, grid: Grid, skip: (mx: number, my: number) => boolean, at: (mx: number, my: number) => [number, number, number]) {
	const { data, width } = lights.getContext('2d')!.getImageData(0, 0, lights.width, lights.height);
	const pxMerc = 1 / (2 ** grid.z * TILE); // the canvas is at the grid's own zoom
	const sites: number[] = [];
	for (let py = 0; py < width; py++) {
		for (let px = 0; px < width; px++) {
			const t = data[(py * width + px) * 4]! / 255;
			if (t < 0.6) continue; // towns, not the rural haze VIIRS also records: dark land between
			const [mx, my] = [grid.x0 / 2 ** grid.z + px * pxMerc, grid.y0 / 2 ** grid.z + py * pxMerc];
			if (skip(mx, my)) continue;
			const n = Math.floor(t * t * 2.5 + hash(py * width + px));
			for (let k = 0; k < n; k++) {
				const seed = (py * width + px) * 8 + k;
				sites.push(...at(mx + hash(seed) * pxMerc, my + hash(seed + 0x9e37) * pxMerc), t);
			}
		}
	}
	return sites;
}

/** A small window of the near imagery around the pin, for sampling after the canvas is gone. */
export function crop(imagery: OffscreenCanvas, grid: Grid, pinMx: number, pinMy: number, toScene: (mx: number, my: number) => [number, number]) {
	const pxMerc = 1 / (2 ** 12 * TILE);
	const [cx, cy] = [(pinMx - grid.x0 / 2 ** grid.z) / pxMerc, (pinMy - grid.y0 / 2 ** grid.z) / pxMerc];
	const [ex] = toScene(pinMx + pxMerc, pinMy);
	const [ox] = toScene(pinMx, pinMy);
	const pxM = ex - ox;
	const half = Math.ceil(CROP_M / pxM);
	const [x0, y0] = [Math.round(cx) - half, Math.round(cy) - half];
	const { data } = imagery.getContext('2d')!.getImageData(x0, y0, half * 2, half * 2);
	const [sx0, sz0] = toScene(grid.x0 / 2 ** grid.z + x0 * pxMerc, grid.y0 / 2 ** grid.z + y0 * pxMerc);
	return (x: number, z: number): [number, number, number] | null => {
		const [px, py] = [Math.floor((x - sx0) / pxM), Math.floor((sz0 - z) / pxM)];
		if (px < 0 || py < 0 || px >= half * 2 || py >= half * 2) return null;
		const i = (py * half * 2 + px) * 4;
		return [data[i]!, data[i + 1]!, data[i + 2]!];
	};
}

/**
 * OSM roads as asphalt lines in the imagery canvas, before it becomes a texture: Sentinel's
 * 10 m pixels, resampled to ~36 m, smear roads into the ground; these stay crisp. Sub-pixel
 * roads draw one pixel wide at partial alpha. A touch warm (red over green) so waterMask
 * never reads a road as water.
 */
export function paintRoads(canvas: OffscreenCanvas, grid: Grid, roads: Road[], mPerMerc: number, ink: (alpha: string) => string) {
	const ctx = canvas.getContext('2d')!;
	const pxPerMerc = canvas.width / (grid.span / 2 ** grid.z);
	const [gx, gy] = [grid.x0 / 2 ** grid.z, grid.y0 / 2 ** grid.z];
	const mPerPx = mPerMerc / pxPerMerc;
	ctx.lineCap = ctx.lineJoin = 'round';
	for (const [cls, metres] of ROAD_M) {
		const w = metres / mPerPx;
		ctx.lineWidth = Math.max(1, w);
		ctx.strokeStyle = ink((0.22 + 0.6 * Math.min(1, w)).toFixed(2));
		ctx.beginPath();
		for (const { geometry, properties } of roads) {
			if (properties.class !== cls) continue;
			geometry.coordinates.forEach(([lon, lat], i) => {
				const [x, y] = [(mercX(lon!) - gx) * pxPerMerc, (mercY(lat!) - gy) * pxPerMerc];
				if (i) ctx.lineTo(x, y);
				else ctx.moveTo(x, y);
			});
		}
		ctx.stroke();
	}
}

/**
 * A tiling 256² detail map in Babylon's layout: R albedo, G/A the normal's y/x, B roughness,
 * 0.5 neutral in each. Wrapping value noise (lattices of 8..64 cells), so repeats don't seam.
 * Raw bytes, not a canvas: a canvas premultiplies RGB by the alpha that carries normal x.
 */
export function groundDetail(scene: Scene) {
	const N = 256;
	const CELLS = 8; // the coarsest octave's lattice across the tile; fbm doubles it per octave
	const sample = (x: number, y: number) => fbm(0xd37a11, (x / N) * CELLS, (y / N) * CELLS, 4, CELLS);
	const data = new Uint8Array(N * N * 4);
	for (let y = 0; y < N; y++) {
		for (let x = 0; x < N; x++) {
			const h = sample(x, y);
			const [dx, dy] = [sample(x + 1, y) - sample(x - 1, y), sample(x, y + 1) - sample(x, y - 1)].map((d) => Math.max(-1, Math.min(1, d * 6)));
			const i = (y * N + x) * 4;
			data[i] = 128 + (h - 0.5) * 140; // albedo mottling
			data[i + 1] = 128 + dy! * 127; // normal y
			data[i + 2] = 128 + (h - 0.5) * 80; // roughness
			data[i + 3] = 128 + dx! * 127; // normal x
		}
	}
	const tex = RawTexture.CreateRGBATexture(data, N, N, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
	tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
	return tex;
}

type Depth = (mx: number, my: number) => number;
/** Global Mercator of pixel (px, py) on a canvas covering `grid`. */
const pixelMerc = (canvas: OffscreenCanvas, grid: Grid, px: number, py: number): [number, number] => {
	const step = grid.span / 2 ** grid.z / canvas.width;
	return [grid.x0 / 2 ** grid.z + (px + 0.5) * step, grid.y0 / 2 ** grid.z + (py + 0.5) * step];
};
const SEA_FLOOR_M = -2; // under this the terrain is sea floor: bathymetry, not a coastal flat
/**
 * Not water's own colour: no-data black, or cloud grey (bright and unsaturated). Sand and reclaimed
 * islands (the Palm, the World: sea floor to the old terrain data) run warm, red over blue; shallows
 * run green and blue over red. Both stay.
 */
// Measured over the Gulf: cloud sums 183-537 with red 0-35 over blue; open sea ~110, blue over red.
const notWater = (r: number, g: number, b: number) => r + g + b < 20 || (r + g + b > 175 && r - b > -6 && r - b < 40 && Math.max(r, g, b) - Math.min(r, g, b) < 45);

/** The mean colour of real water in the imagery (sea floor below, not cloud), or null for an inland place. */
export function seaColour(imagery: OffscreenCanvas, grid: Grid, depthAt: Depth): [number, number, number] | null {
	const { data, width } = imagery.getContext('2d')!.getImageData(0, 0, imagery.width, imagery.height);
	const sum = [0, 0, 0, 0];
	for (let py = 0; py < width; py += 8) {
		for (let px = 0; px < width; px += 8) {
			const i = (py * width + px) * 4;
			if (notWater(data[i]!, data[i + 1]!, data[i + 2]!) || depthAt(...pixelMerc(imagery, grid, px, py)) > SEA_FLOOR_M) continue;
			sum[0]! += data[i]!, sum[1]! += data[i + 1]!, sum[2]! += data[i + 2]!, sum[3]!++;
		}
	}
	return sum[3]! > 500 ? [sum[0]! / sum[3]!, sum[1]! / sum[3]!, sum[2]! / sum[3]!] : null;
}

/**
 * One sea. Where the terrain says sea floor, cloud and no-data in the imagery become `sea` (a cloudy
 * Sentinel scene over the Gulf read from the window as a snowy plateau with a straight swath edge),
 * and real water moves `blend` of the way to it. The far ring takes 0.85: it stacks Sentinel's z8 over
 * an older z7 that disagree on water, and showed the seam as a land-coloured slab on the horizon.
 * The near patch takes 0, keeping its own water's texture. The coast fades over a few metres of depth.
 */
export function paintSea(imagery: OffscreenCanvas, grid: Grid, depthAt: Depth, sea: [number, number, number], blend: number) {
	const ctx = imagery.getContext('2d')!;
	const image = ctx.getImageData(0, 0, imagery.width, imagery.height);
	const { data, width } = image;
	for (let py = 0; py < width; py++) {
		for (let px = 0; px < width; px++) {
			const deep = smoothstep(SEA_FLOOR_M + 1, SEA_FLOOR_M - 8, depthAt(...pixelMerc(imagery, grid, px, py)));
			if (deep === 0) continue;
			const i = (py * width + px) * 4;
			const k = deep * (notWater(data[i]!, data[i + 1]!, data[i + 2]!) ? 1 : blend);
			for (let c = 0; c < 3; c++) data[i + c] = data[i + c]! + (sea[c]! - data[i + c]!) * k;
		}
	}
	ctx.putImageData(image, 0, 0);
}
