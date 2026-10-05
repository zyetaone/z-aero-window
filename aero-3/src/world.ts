/**
 * The ground: a detailed patch around the place and a coarse ring out past the
 * horizon, both cut from Web Mercator tiles and both bent by Earth's curvature
 * so the horizon dips and sinks the way it does from a cruising window.
 *
 * Scene frame: metres (Babylon's atmosphere reads scene units as metres), x
 * east, y up, z north, origin at sea level over the centre of the detail patch.
 * Positions come from global Mercator (mercator.ts), so the two patches, the
 * buildings and the pin share one projection. The maps baked from the tiles
 * (night, water, roads, detail) live in ground-maps.ts.
 */
import { Color3, MeshBuilder, PBRMaterial, Texture, VertexBuffer, VertexData, type Scene } from '@babylonjs/core';
import { crop, groundDetail, lightDome, lightSites, nightGround, paintRoads, paintSea, seaColour, waterMask } from './ground-maps.ts';
import { RAD } from './math.ts';
import { gridsFor, mercX, mercY, TILE, type Grid } from './mercator.ts';
import type { Road } from './lights.ts';

const EARTH_M = 6_371_000;
const DETAIL_M = 350; // one repeat of the ground's detail map

/** `roads` (the place's OSM pack, or null) are painted into the near imagery by day. */
export async function createWorld(scene: Scene, lat: number, lon: number, roads: Road[] | null = null) {
	const { near, far } = gridsFor(lat, lon);

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
				ctx.drawImage(layer === 'imagery' ? clearNoData(bitmap) : bitmap, (x / f - gx) * 2 ** outZ * TILE, (y / f - gy) * 2 ** outZ * TILE, size, size);
				bitmap.close();
			}
		}
		return canvas;
	}

	/** Terrain height in metres at a global Mercator point, from terrarium tiles; `.raw` keeps the sea floor. */
	async function heights(grid: Grid) {
		// #800000 is terrarium's 0 m, so a missing tile reads as sea level, not -32 km.
		const canvas = await mosaic('terrain', 'png', grid, grid.z, [grid.z], '#800000');
		const { data, width } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
		const raw = (mx: number, my: number) => {
			const px = Math.min(width - 1, Math.max(0, Math.round((mx * 2 ** grid.z - grid.x0) * TILE)));
			const py = Math.min(width - 1, Math.max(0, Math.round((my * 2 ** grid.z - grid.y0) * TILE)));
			const i = (py * width + px) * 4;
			return data[i]! * 256 + data[i + 1]! + data[i + 2]! / 256 - 32_768;
		};
		return Object.assign((mx: number, my: number) => Math.max(0, raw(mx, my)), { raw });
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
			positions[i + 1] = heightAt(mx, my) - drop(x, z) - (sink?.(mx, my) ? SINK_M : 0);
		}
		const normals: number[] = [];
		VertexData.ComputeNormals(positions, mesh.getIndices(), normals);
		mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
		mesh.updateVerticesData(VertexBuffer.NormalKind, normals);
		mesh.refreshBoundingInfo();

		const material = new PBRMaterial(name, scene);
		[material.albedoTexture, material.emissiveTexture] = await Promise.all([
			texture(`${name}-imagery`, imagery),
			texture(`${name}-lights`, nightGround(lights, imagery, name === 'near' ? roadMask : null))
		]);
		// Water from the imagery itself: smooth where it reads as water, so lakes, rivers and
		// the sea catch the sun as a glint, and stay matt land everywhere else.
		material.metallicTexture = await texture(`${name}-water`, waterMask(imagery));
		// Lights and water are soft: anisotropic filtering (Babylon's default 4) buys them nothing on a Pi.
		material.emissiveTexture!.anisotropicFilteringLevel = material.metallicTexture.anisotropicFilteringLevel = 1;
		material.useRoughnessFromMetallicTextureGreen = true;
		material.useMetallnessFromMetallicTextureBlue = true;
		material.ambientColor = Color3.White(); // take the sky's light, like the buildings and trees
		material.emissiveColor = Color3.White();
		material.metallic = 1; // multipliers on the mask: metal stays 0, roughness comes from G
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

	// One sea across both patches: the far ring's two imagery sources disagree on water (see paintSea).
	const sea = seaColour(nearImagery, near, nearHeights.raw);
	if (sea) {
		paintSea(nearImagery, near, nearHeights.raw, sea, 0);
		paintSea(farImagery, far, farHeights.raw, sea, 0.85);
	}

	// Roads twice: asphalt into the day imagery, and white into a mask the night ground composes
	// with NASA's radiance (nightGround), so lit districts' streets glow sodium under the lamps.
	let roadMask = roads ? new OffscreenCanvas(nearImagery.width, nearImagery.height) : null;
	if (roads && roadMask) {
		paintRoads(nearImagery, near, roads, mPerMerc, (a) => `rgba(60,56,52,${a})`);
		paintRoads(roadMask, near, roads, mPerMerc, (a) => `rgba(255,255,255,${a})`);
	}
	const inNear = (mx: number, my: number) => nearEdge(mx, near.x0) && nearEdge(my, near.y0);
	// Inclusive of the border, so far-ring vertices on the near patch's edge take the near
	// heights and the two meshes meet instead of stepping z10 against z8.
	const onNear = (mx: number, my: number) => [mx * 2 ** 10 - near.x0, my * 2 ** 10 - near.y0].every((t) => t >= -1e-3 && t <= near.span + 1e-3);
	const heightAt = (mx: number, my: number) => (onNear(mx, my) ? nearHeights : farHeights)(mx, my);
	// Read before nightGround rewrites the canvases in place: towns on the far ring.
	const at = (mx: number, my: number): [number, number, number] => {
		const [x, z] = [(mx - mx0) * mPerMerc, -(my - my0) * mPerMerc];
		return [x, heightAt(mx, my) - drop(x, z) + 10, z];
	};
	const sites = lightSites(farLights, far, inNear, at);
	const hazeMap = lightDome(nearLights);
	const imagery = crop(nearImagery, near, mercX(lon), mercY(lat), (mx, my) => [(mx - mx0) * mPerMerc, -(my - my0) * mPerMerc]);

	// The 1e-3 tile slack keeps float32 border vertices on the border, not sunk.
	const materials = await Promise.all([
		patch('near', near, nearHeights, nearImagery, nearLights, 256),
		// 160 subdivisions over 20 z10 tiles puts a vertex line on every z10 tile
		// edge, so only vertices strictly inside the near patch sink under it.
		patch('far', far, heightAt, farImagery, farLights, 160, inNear)
	]);

	roadMask = null; // baked into the near night ground: let the 37 MB canvas go (the closures below outlive boot)

	// Grain at the 1-100 m scale the 36 m/px imagery cannot hold: Babylon's PBR detail map,
	// near patch only (the far ring is never close enough to show it).
	const detail = groundDetail(scene);
	detail.uScale = detail.vScale = (near.span / 2 ** near.z) * mPerMerc / DETAIL_M;
	Object.assign(materials[0]!.detailMap, { texture: detail, isEnabled: true, diffuseBlendLevel: 0.12, normalBlendLevel: 0.08, roughnessBlendLevel: 0.15 /* any stronger and the 350 m repeat shows as a grid */ });

	return {
		project,
		drop,
		/** Ground in scene metres under (x, z), curvature included. */
		groundAt: (x: number, z: number) => heightAt(mx0 + x / mPerMerc, my0 - z / mPerMerc) - drop(x, z),
		materials,
		/** Far-ring towns from NASA's radiance: [x, y, z, radiance 0..1] per light (lights.ts). */
		sites,
		/** The imagery's RGB under (x, z) within CROP_M of the pin, else null (trees.ts). */
		imagery,
		/** The light dome over the near patch: VIIRS blurred, broken up by noise (haze.ts). */
		hazeMap,
		/** The near patch's side in metres, centred on the origin. */
		nearSizeM: (near.span / 2 ** near.z) * mPerMerc
	};
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);


/**
 * Sentinel's no-data is pure black: a swath edge cuts 15-70% of a far z8 tile (Dubai, measured).
 * Drawn over z7, it walled the Iranian coast off in straight black edges, a rectangle on the
 * horizon. Transparent instead, so the coarser zoom under it shows through.
 */
function clearNoData(bitmap: ImageBitmap) {
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const ctx = canvas.getContext('2d')!;
	ctx.drawImage(bitmap, 0, 0);
	const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
	const d = image.data;
	for (let i = 0; i < d.length; i += 4) if (d[i]! + d[i + 1]! + d[i + 2]! < 20) d[i + 3] = 0; // deep sea is ~60, no-data 0 (JPEG: a few)
	ctx.putImageData(image, 0, 0);
	return canvas;
}

/** Missing tiles (unpacked ocean, edge of the pack) come back null and stay background. */
async function fetchTile(url: string): Promise<ImageBitmap | null> {
	const res = await fetch(url);
	return res.ok ? createImageBitmap(await res.blob()) : null;
}

// How far the far ring drops under the detail patch. 500 m was plenty in a flat city; in the
// Himalayas z8's coarse peaks overshoot z10's by more and poked through as grey flat sheets.
const SINK_M = 3_000;
