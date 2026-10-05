/**
 * The ground: a detailed patch around the place and a coarse ring out past the
 * horizon, both cut from Web Mercator tiles and both bent by Earth's curvature
 * so the horizon dips and sinks the way it does from a cruising window.
 *
 * Scene frame: metres (Babylon's atmosphere reads scene units as metres), x
 * east, y up, z north, origin at sea level over the centre of the detail patch. Positions come from global Mercator (0..1 across the
 * world), so the two patches, the buildings and the pin share one projection.
 */
import { Color3, DynamicTexture, MeshBuilder, PBRMaterial, Texture, VertexBuffer, VertexData, type Scene } from '@babylonjs/core';

const RAD = Math.PI / 180;
const TILE = 256;
const EARTH_M = 6_371_000;

/** `span` × `span` tiles at zoom `z`, top-left tile (x0, y0). */
type Grid = { z: number; x0: number; y0: number; span: number };

const mercX = (lon: number) => (lon + 180) / 360;
const mercY = (lat: number) => (1 - Math.asinh(Math.tan(lat * RAD)) / Math.PI) / 2;

export const smoothstep = (a: number, b: number, x: number) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

export async function createWorld(scene: Scene, lat: number, lon: number) {
	const tile10 = (z: number, m: number) => Math.floor(m * 2 ** z);
	const [cx, cy] = [tile10(10, mercX(lon)), tile10(10, mercY(lat))];
	// ~37 km tiles: 5×5 is ~190 km of relief and imagery around the place.
	const near: Grid = { z: 10, x0: cx - 2, y0: cy - 2, span: 5 };
	// ~150 km tiles: 5×5 is ~750 km, past the ~225 km horizon at cruise. Its z10
	// footprint always contains the near patch (cx/4 rounds down by at most 3).
	const far: Grid = { z: 8, x0: Math.floor(cx / 4) - 2, y0: Math.floor(cy / 4) - 2, span: 5 };

	const [mx0, my0] = [(near.x0 + 2.5) / 2 ** 10, (near.y0 + 2.5) / 2 ** 10];
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

	function texture(name: string, canvas: OffscreenCanvas) {
		const tex = new DynamicTexture(name, { width: canvas.width, height: canvas.height }, scene, true);
		tex.getContext().drawImage(canvas, 0, 0);
		tex.update();
		tex.wrapU = tex.wrapV = Texture.CLAMP_ADDRESSMODE;
		return tex;
	}

	function patch(name: string, grid: Grid, heightAt: (mx: number, my: number) => number, imagery: OffscreenCanvas, lights: OffscreenCanvas, subdivisions: number, sink?: (mx: number, my: number) => boolean) {
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
		material.albedoTexture = texture(`${name}-imagery`, imagery);
		material.emissiveTexture = texture(`${name}-lights`, kneeLights(lights));
		material.emissiveColor = Color3.White();
		material.metallic = 0;
		material.roughness = 1;
		mesh.material = material;
		mesh.freezeWorldMatrix();
		return material;
	}

	const [nearHeights, farHeights, nearImagery, farImagery, nearLights, farLights] = await Promise.all([
		heights(near),
		heights(far),
		mosaic('imagery', 'jpg', near, 11, [11], '#3a4048'),
		mosaic('imagery', 'jpg', far, 8, [7, 8], '#3a4048'),
		// Raw VIIRS radiance under each patch, aero-2's baked lamp dots at z11 over the core.
		mosaic('lights', 'png', near, 11, [8, 11], '#000'),
		mosaic('lights', 'png', far, 8, [8], '#000')
	]);

	// The 1e-3 tile slack keeps float32 border vertices on the border, not sunk.
	const nearEdge = (m: number, origin: number) => m * 2 ** 10 > origin + 1e-3 && m * 2 ** 10 < origin + near.span - 1e-3;
	const materials = [
		patch('near', near, nearHeights, nearImagery, nearLights, 256),
		// 160 subdivisions over 20 z10 tiles puts a vertex line on every near-patch
		// edge, so only vertices strictly inside it sink under the detail patch.
		patch('far', far, farHeights, farImagery, farLights, 160, (mx, my) => nearEdge(mx, near.x0) && nearEdge(my, near.y0))
	];

	return {
		project,
		drop,
		/** Ground in scene metres under (x, z), curvature included. */
		groundAt: (x: number, z: number) => nearHeights(mx0 + x / mPerMerc, my0 - z / mPerMerc) - drop(x, z),
		materials
	};
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

/** Missing tiles (unpacked ocean, edge of the pack) come back null and stay background. */
async function fetchTile(url: string): Promise<ImageBitmap | null> {
	const res = await fetch(url);
	return res.ok ? createImageBitmap(await res.blob()) : null;
}

/**
 * aero-2's VIIRS tint (server/viirs-tint.ts), cut to its two load-bearing
 * parts and run once at boot: a luminance knee at 0.35..0.75, because raw
 * VIIRS over a city is mid-bright almost everywhere and anything lower pastes
 * a cream sheet over it; and grey radiance dealt amber. Baked lamp pixels
 * already carry their road's colour and keep it.
 */
function kneeLights(canvas: OffscreenCanvas) {
	const ctx = canvas.getContext('2d')!;
	const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
	const d = image.data;
	for (let i = 0; i < d.length; i += 4) {
		const [r, g, b] = [d[i]!, d[i + 1]!, d[i + 2]!];
		const t = Math.max(r, g, b) / 255;
		const k = smoothstep(0.35, 0.75, t) * (0.25 + 0.6 * t * t);
		const grey = Math.max(r, g, b) - Math.min(r, g, b) < 24;
		d[i] = (grey ? 255 : r) * k;
		d[i + 1] = (grey ? 150 : g) * k;
		d[i + 2] = (grey ? 60 : b) * k;
	}
	ctx.putImageData(image, 0, 0);
	return canvas;
}
