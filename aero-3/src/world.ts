/**
 * The ground: a detailed patch around the place and a coarse ring out past the
 * horizon, both cut from Web Mercator tiles and both bent by Earth's curvature
 * so the horizon dips and sinks the way it does from a cruising window.
 *
 * Scene frame: metres (Babylon's atmosphere reads scene units as metres), x
 * east, y up, z north, origin at sea level over the centre of the detail patch. Positions come from global Mercator (0..1 across the
 * world), so the two patches, the buildings and the pin share one projection.
 */
import { Color3, MeshBuilder, PBRMaterial, Texture, VertexBuffer, VertexData, type Scene } from '@babylonjs/core';
import { hash, RAD, smoothstep } from './math.ts';

const TILE = 256;
const EARTH_M = 6_371_000;

/** `span` × `span` tiles at zoom `z`, top-left tile (x0, y0). */
type Grid = { z: number; x0: number; y0: number; span: number };

const mercX = (lon: number) => (lon + 180) / 360;
const mercY = (lat: number) => (1 - Math.asinh(Math.tan(lat * RAD)) / Math.PI) / 2;


export async function createWorld(scene: Scene, lat: number, lon: number) {
	const tile10 = (z: number, m: number) => Math.floor(m * 2 ** z);
	const [cx, cy] = [tile10(10, mercX(lon)), tile10(10, mercY(lat))];
	// ~37 km tiles: 3×3 is ~110 km around the place, sized so its z12 imagery (3072 px,
	// ~37 m/px) fits the Pi's 4096 px texture limit. z11 over 5×5 smeared like wet paint.
	const near: Grid = { z: 10, x0: cx - 1, y0: cy - 1, span: 3 };
	// ~150 km tiles: 5×5 is ~750 km, past the ~225 km horizon at cruise. Its z10
	// footprint always contains the near patch (cx/4 rounds down by at most 3).
	const far: Grid = { z: 8, x0: Math.floor(cx / 4) - 2, y0: Math.floor(cy / 4) - 2, span: 5 };

	const [mx0, my0] = [(near.x0 + near.span / 2) / 2 ** 10, (near.y0 + near.span / 2) / 2 ** 10];
	const mPerMerc = 40_075_017 * Math.cos(lat * RAD);

	const project = (lonDeg: number, latDeg: number): [x: number, z: number] => [
		(mercX(lonDeg) - mx0) * mPerMerc,
		-(mercY(latDeg) - my0) * mPerMerc
	];
	/** How far the Earth has curved away below the tangent plane at the origin. */
	const drop = (x: number, z: number) => (x * x + z * z) / (2 * EARTH_M);

	/** Stack `{z}/{y}/{x}` tiles onto one canvas at `outZ` resolution, coarse zooms first. */
	async function mosaic(layer: string, ext: string, grid: Grid, outZ: number, zooms: number[], background: string) {
		const side = grid.span * 2 ** (outZ - grid.z) * TILE;
		const canvas = new OffscreenCanvas(side, side);
		const ctx = canvas.getContext('2d', { willReadFrequently: layer === 'terrain' })!;
		ctx.fillStyle = background;
		ctx.fillRect(0, 0, side, side);
		const [gx, gy] = [grid.x0 / 2 ** grid.z, grid.y0 / 2 ** grid.z];
		const gw = grid.span / 2 ** grid.z;

		for (const z of zooms) {
			const f = 2 ** z;
			const size = TILE * 2 ** (outZ - z);
			const xs = range(Math.floor(gx * f), Math.ceil((gx + gw) * f));
			const ys = range(Math.floor(gy * f), Math.ceil((gy + gw) * f));
			const tiles = await Promise.all(
				ys.flatMap((y) => xs.map(async (x) => ({ x, y, bitmap: await fetchTile(`/tiles/${layer}/${z}/${y}/${x}.${ext}`) })))
			);
			for (const { x, y, bitmap } of tiles) {
				if (!bitmap) continue;
				ctx.drawImage(bitmap, (x / f - gx) * 2 ** outZ * TILE, (y / f - gy) * 2 ** outZ * TILE, size, size);
				bitmap.close();
			}
		}
		return canvas;
	}

	/** Terrain height in metres at a global Mercator point, from terrarium tiles. */
	async function heights(grid: Grid) {
		// #800000 is terrarium's 0 m, so a missing tile reads as sea level, not -32 km.
		const canvas = await mosaic('terrain', 'png', grid, grid.z, [grid.z], '#800000');
		const { data, width } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
		return (mx: number, my: number) => {
			const px = Math.min(width - 1, Math.max(0, Math.round((mx * 2 ** grid.z - grid.x0) * TILE)));
			const py = Math.min(width - 1, Math.max(0, Math.round((my * 2 ** grid.z - grid.y0) * TILE)));
			const i = (py * width + px) * 4;
			return Math.max(0, data[i]! * 256 + data[i + 1]! + data[i + 2]! / 256 - 32_768);
		};
	}

	/**
	 * A canvas into a GPU texture with no CPU copy left behind: a DynamicTexture keeps
	 * its own canvas for life (37 MB for the near imagery). A JPEG blob is ~2 MB and
	 * is what Babylon re-reads if the GL context is ever lost.
	 */
	async function texture(name: string, canvas: OffscreenCanvas) {
		const url = URL.createObjectURL(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 }));
		return new Promise<Texture>((resolve, reject) => {
			const tex: Texture = new Texture(url, scene, { mimeType: 'image/jpeg', onLoad: () => resolve(tex), onError: (m) => reject(new Error(`${name}: ${m}`)) });
			tex.name = name;
			tex.wrapU = tex.wrapV = Texture.CLAMP_ADDRESSMODE;
		});
	}

	async function patch(name: string, grid: Grid, heightAt: (mx: number, my: number) => number, imagery: OffscreenCanvas, lights: OffscreenCanvas, subdivisions: number, sink?: (mx: number, my: number) => boolean) {
		const sizeMerc = grid.span / 2 ** grid.z;
		const size = sizeMerc * mPerMerc;
		const [ox, oz] = [(grid.x0 / 2 ** grid.z + sizeMerc / 2 - mx0) * mPerMerc, -(grid.y0 / 2 ** grid.z + sizeMerc / 2 - my0) * mPerMerc];
		const mesh = MeshBuilder.CreateGround(name, { width: size, height: size, subdivisions, updatable: true }, scene);
		const positions = mesh.getVerticesData(VertexBuffer.PositionKind)!;
		for (let i = 0; i < positions.length; i += 3) {
			const [x, z] = [positions[i]! + ox, positions[i + 2]! + oz];
			const [mx, my] = [mx0 + x / mPerMerc, my0 - z / mPerMerc];
			positions[i] = x;
			positions[i + 2] = z;
			positions[i + 1] = heightAt(mx, my) - drop(x, z) - (sink?.(mx, my) ? 500 : 0);
		}
		const normals: number[] = [];
		VertexData.ComputeNormals(positions, mesh.getIndices(), normals);
		mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
		mesh.updateVerticesData(VertexBuffer.NormalKind, normals);
		mesh.refreshBoundingInfo();

		const material = new PBRMaterial(name, scene);
		[material.albedoTexture, material.emissiveTexture] = await Promise.all([
			texture(`${name}-imagery`, imagery),
			texture(`${name}-lights`, nightGround(lights, imagery))
		]);
		material.emissiveColor = Color3.White();
		material.metallic = 0;
		material.roughness = 1;
		mesh.material = material;
		mesh.freezeWorldMatrix();
		return material;
	}

	const nearEdge = (m: number, origin: number) => m * 2 ** 10 > origin + 1e-3 && m * 2 ** 10 < origin + near.span - 1e-3;
	const [nearHeights, farHeights, nearImagery, farImagery, nearLights, farLights] = await Promise.all([
		heights(near),
		heights(far),
		mosaic('imagery', 'jpg', near, 12, [11, 12], '#3a4048'),
		mosaic('imagery', 'jpg', far, 8, [7, 8], '#3a4048'),
		// NASA's VIIRS radiance (GIBS caps it at z8, ~600 m/px), stretched smooth onto each
		// patch's imagery grid so it can mask the imagery (nightGround). aero-2's baked z11
		// lamp dots upscaled into amber and blue blocks.
		mosaic('lights', 'png', near, 12, [8], '#000'),
		mosaic('lights', 'png', far, 8, [8], '#000')
	]);

	const inNear = (mx: number, my: number) => nearEdge(mx, near.x0) && nearEdge(my, near.y0);
	// Inclusive of the border, so far-ring vertices on the near patch's edge take the near
	// heights and the two meshes meet instead of stepping z10 against z8.
	const onNear = (mx: number, my: number) => [mx * 2 ** 10 - near.x0, my * 2 ** 10 - near.y0].every((t) => t >= -1e-3 && t <= near.span + 1e-3);
	const heightAt = (mx: number, my: number) => (onNear(mx, my) ? nearHeights : farHeights)(mx, my);
	// Read before nightGround rewrites the canvases in place.
	const sites = lightSites(farLights, far, inNear, (mx, my) => {
		const [x, z] = [(mx - mx0) * mPerMerc, -(my - my0) * mPerMerc];
		return [x, heightAt(mx, my) - drop(x, z) + 10, z];
	});
	const imagery = crop(nearImagery, near, mercX(lon), mercY(lat), (mx, my) => [(mx - mx0) * mPerMerc, -(my - my0) * mPerMerc]);

	// The 1e-3 tile slack keeps float32 border vertices on the border, not sunk.
	const materials = await Promise.all([
		patch('near', near, nearHeights, nearImagery, nearLights, 256),
		// 160 subdivisions over 20 z10 tiles puts a vertex line on every z10 tile
		// edge, so only vertices strictly inside the near patch sink under it.
		patch('far', far, heightAt, farImagery, farLights, 160, inNear)
	]);

	return {
		project,
		drop,
		/** Ground in scene metres under (x, z), curvature included. */
		groundAt: (x: number, z: number) => heightAt(mx0 + x / mPerMerc, my0 - z / mPerMerc) - drop(x, z),
		materials,
		/** Far-ring towns from NASA's radiance: [x, y, z, radiance 0..1] per light (lights.ts). */
		sites,
		/** The imagery's RGB under (x, z) within CROP_M of the pin, else null (trees.ts). */
		imagery
	};
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

/** Missing tiles (unpacked ocean, edge of the pack) come back null and stay background. */
async function fetchTile(url: string): Promise<ImageBitmap | null> {
	const res = await fetch(url);
	return res.ok ? createImageBitmap(await res.blob()) : null;
}

const GLOW = 0.12; // NASA's radiance as a faint carpet: the points carry the detail
const REVEAL = 0.3; // how much of the real ground a lit district shows at night
const CROP_M = 6_000; // imagery kept for sampling (trees), either side of the pin

/**
 * The night ground, once at boot, from NASA's VIIRS radiance alone: aero-2's
 * luminance knee at 0.35..0.75 (raw VIIRS over a city is mid-bright almost
 * everywhere, and anything lower pastes a cream sheet over it) as a faint amber
 * glow, and the same radiance as a mask that lets the real imagery show through
 * warm where a district is lit — streets, roofs and parks read under the lamps
 * instead of a flat orange. `lights` is rewritten in place and returned.
 */
function nightGround(lights: OffscreenCanvas, imagery: OffscreenCanvas) {
	const ctx = lights.getContext('2d')!;
	const image = ctx.getImageData(0, 0, lights.width, lights.height);
	const [d, ground] = [image.data, imagery.getContext('2d')!.getImageData(0, 0, imagery.width, imagery.height).data];
	for (let i = 0; i < d.length; i += 4) {
		const t = Math.max(d[i]!, d[i + 1]!, d[i + 2]!) / 255;
		if (t < 0.3) {
			d[i] = d[i + 1] = d[i + 2] = 0; // most of the map is dark: skip the maths
			continue;
		}
		const k = smoothstep(0.35, 0.75, t) * (0.25 + 0.6 * t * t) * GLOW;
		const lit = smoothstep(0.3, 0.8, t) * REVEAL;
		d[i] = 255 * k + ground[i]! * lit;
		d[i + 1] = 150 * k + ground[i + 1]! * lit * 0.8;
		d[i + 2] = 60 * k + ground[i + 2]! * lit * 0.6;
	}
	ctx.putImageData(image, 0, 0);
	return lights;
}

/**
 * Towns beyond the road pack, from NASA's radiance: each bright far-ring pixel
 * (~600 m) becomes a cluster of up to three lights, more the brighter it is,
 * jittered inside the pixel by hash so every pane places the same ones. Derived
 * from the map, not invented, and only where the road pack has no points.
 */
function lightSites(lights: OffscreenCanvas, grid: Grid, skip: (mx: number, my: number) => boolean, at: (mx: number, my: number) => [number, number, number]) {
	const { data, width } = lights.getContext('2d')!.getImageData(0, 0, lights.width, lights.height);
	const pxMerc = 1 / (2 ** grid.z * TILE);
	const sites: number[] = [];
	for (let py = 0; py < width; py++) {
		for (let px = 0; px < width; px++) {
			const t = data[(py * width + px) * 4]! / 255;
			if (t < 0.5) continue; // towns, not the rural haze VIIRS also records
			const [mx, my] = [grid.x0 / 2 ** grid.z + px * pxMerc, grid.y0 / 2 ** grid.z + py * pxMerc];
			if (skip(mx, my)) continue;
			const n = Math.floor(t * t * 3 + hash(py * width + px));
			for (let k = 0; k < n; k++) {
				const seed = (py * width + px) * 8 + k;
				sites.push(...at(mx + hash(seed) * pxMerc, my + hash(seed + 0x9e37) * pxMerc), t);
			}
		}
	}
	return sites;
}

/** A small window of the near imagery around the pin, for sampling after the canvas is gone. */
function crop(imagery: OffscreenCanvas, grid: Grid, pinMx: number, pinMy: number, toScene: (mx: number, my: number) => [number, number]) {
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
