/**
 * OSM footprints extruded into one mesh: one draw call for the whole city.
 *
 * Built at boot from the GeoJSON `aero-2/tools/fetch-buildings.py` writes, so
 * there is no bake step and no tile format. 3D Tiles would add a traversal
 * library and per-frame tile selection on a CPU-bound Pi to stream geometry
 * that fits in one buffer; it earns its place for photogrammetry, not boxes.
 *
 * White, like an architect's model: from cruise height a building is a few
 * pixels, and painted facades, window grids and glass tints only aliased into
 * dark specks over the map. Each building is a shade off white so a block
 * still reads as separate houses; roofs a touch darker than the walls. A baked
 * lightmap (second UV set) darkens each wall toward the street as ambient
 * occlusion, so blocks sit on the ground. At night one emissive texture lights
 * rooms in short runs along each floor (and, on small buildings, a door lamp's
 * pool falling off up the wall, or a lit roof), and a generated normal map recesses
 * every window on the same grid, so a facade catches the sun and the moon as
 * relief, not a flat white (or, at night, flat black) slab. Each building stands
 * on the terrain under its first corner.
 */
import earcut from 'earcut';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { Scene } from '@babylonjs/core/scene';
import { mulberry32 } from '#math.ts';

type Footprint = { geometry: { coordinates: number[][][] }; properties: { height: number } };

const CELLS = 16; // windows per texture side
const CELL_PX = 16;
const FACADE_M = CELLS * 3; // one texture repeat is 16 windows of 3 m
const AO_M = 40; // occlusion fades out this far up a wall
const WHITE = 0.8; // albedo: white without blowing out under a high sun
const ROOF = 0.88; // roofs this much of their walls
const WINDOW_M2 = 320; // one lit window point per this much wall, on buildings WINDOW_MIN_M up
const ROOF_M2 = 3_000; // one roof light (stair heads, terrace bulbs, signs) per this much flat roof
const ROOF_LIT = 0.45; // and only on this share of buildings: most roofs are dark
const WINDOW_MIN_M = 12;
const HOUSE_LIT = 0.6; // share of buildings under WINDOW_MIN_M with a light on
const ROOF_POOL = 0.2; // share of buildings under WINDOW_MIN_M with a lit terrace or roof lamp
// Two cells of the lit-room texture (canvas row 0, so the top of UV space) hold light pools, not rooms:
// a lamp's wash up a house's door wall, and a soft patch for a lit roof. Inset a texel against bleed.
const POOL = { wall: 15, roof: 14 } as const;
const cellU = (col: number, t: number) => (col * CELL_PX + 1 + t * (CELL_PX - 2)) / (CELLS * CELL_PX);
const cellV = (t: number) => 1 - (CELL_PX - 1 - t * (CELL_PX - 2)) / (CELLS * CELL_PX); // t 0 bottom, 1 top
const RELIEF = 0.8; // normal-map strength: mipmaps average it flat with distance, so it never aliases

export function createBuildings(features: Footprint[], project: (lon: number, lat: number) => [x: number, z: number], groundAt: (x: number, z: number) => number, scene: Scene) {
	// uvs2 is the lightmap: v is height up the wall, 0 at the street.
	const [positions, normals, uvs, uvs2, colors, indices] = [[], [], [], [], [], []] as number[][];
	const roofLights: number[] = []; // flat [x, y, z]: lights on the flat roofs (city/lights.ts)
	const windows: number[] = []; // flat [x, y, z]: lit windows as points (city/lights.ts), crisp at range
	const random = mulberry32(0xae3);

	for (const { geometry, properties } of features) {
		// GeoJSON closes the ring by repeating the first point; drop it.
		const ring = geometry.coordinates[0]!.slice(0, -1).map(([lon, lat]) => project(lon!, lat!));
		if (ring.length < 3) continue;
		const base = groundAt(...ring[0]!);
		const top = base + properties.height;
		const vTop = properties.height / FACADE_M;
		const shade = 0.9 + random() * 0.12; // a shade off white per building
		const [wall, roof] = [[shade, shade, shade, 1], [shade * ROOF, shade * ROOF, shade * ROOF, 1]];
		// A whole-window shift per building, so neighbours don't light the same rooms.
		const [u0, v0] = [Math.floor(random() * CELLS) / CELLS, Math.floor(random() * CELLS) / CELLS];

		// Shoelace sign: walls face outward whichever way OSM wound the ring.
		const area = ring.reduce((sum, [x, z], i) => {
			const [nx, nz] = ring[(i + 1) % ring.length]!;
			return sum + x * nz - nx * z;
		}, 0);
		const out = area > 0 ? 1 : -1;
		const small = properties.height < WINDOW_MIN_M;
		const [houseLit, roofPool] = [small && random() < HOUSE_LIT, small && random() < ROOF_POOL];

		let along = u0;
		for (const [i, [x0, z0]] of ring.entries()) {
			const [x1, z1] = ring[(i + 1) % ring.length]!;
			const len = Math.hypot(x1 - x0, z1 - z0) || 1e-6;
			const [nx, nz] = [(out * (z1 - z0)) / len, (-out * (x1 - x0)) / len];
			const u1 = along + len / FACADE_M;
			const v = positions.length / 3;
			positions.push(x0, base, z0, x1, base, z1, x1, top, z1, x0, top, z0);
			// A lit house's door wall carries the lamp's pool, bright at the door and falling off up the wall.
			if (houseLit && i === 0) uvs.push(cellU(POOL.wall, 0), cellV(0), cellU(POOL.wall, 1), cellV(0), cellU(POOL.wall, 1), cellV(1), cellU(POOL.wall, 0), cellV(1));
			else uvs.push(along, v0, u1, v0, u1, v0 + vTop, along, v0 + vTop);
			const aoTop = Math.min(1, properties.height / AO_M);
			uvs2.push(0.5, 0, 0.5, 0, 0.5, aoTop, 0.5, aoTop);
			for (let k = 0; k < 4; k++) normals.push(nx, 0, nz), colors.push(...wall);
			indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
			// A few lit rooms on this wall: a point a metre proud of it, on a whole floor.
			if (properties.height >= WINDOW_MIN_M) {
				for (let w = Math.floor((len * properties.height) / WINDOW_M2 + random()); w > 0; w--) {
					const [t, floor] = [random(), Math.floor(random() * (properties.height / 3 - 1)) + 1];
					windows.push(x0 + (x1 - x0) * t + nx, base + floor * 3 + 1.5, z0 + (z1 - z0) * t + nz);
				}
			} else if (i === 0 && houseLit) {
				// A house: one light by its first wall, at door height. Villa districts (the Palm's
				// fronds, suburbs everywhere) were dark: no road lamps there, no tall windows.
				windows.push(x0 + (x1 - x0) * 0.5 + nx, base + 2.5, z0 + (z1 - z0) * 0.5 + nz);
			}
			along = u1;
		}

		const v = positions.length / 3;
		// A lit roof spreads the roof pool over its footprint's box; the rest sample a corner texel, dark in every cell.
		const [minX, minZ] = [Math.min(...ring.map((p) => p[0])), Math.min(...ring.map((p) => p[1]))];
		const [spanX, spanZ] = [Math.max(...ring.map((p) => p[0])) - minX || 1, Math.max(...ring.map((p) => p[1])) - minZ || 1];
		for (const [x, z] of ring) {
			positions.push(x, top, z);
			normals.push(0, 1, 0);
			colors.push(...roof);
			if (roofPool) uvs.push(cellU(POOL.roof, (x - minX) / spanX), cellV((z - minZ) / spanZ));
			else uvs.push(1 / (CELLS * CELL_PX), 1 / (CELLS * CELL_PX));
			uvs2.push(0.5, 1); // roofs are open sky: unoccluded
		}
		const tris = earcut(ring.flat());
		for (const i of tris) indices.push(v + i);
		// Roof lights scattered over the roof's triangles by area: at least one per building,
		// more on the big flat ones. Barycentric draws stay inside the footprint.
		let lit = random() < ROOF_LIT ? 0 : -1; // -1: this roof stays dark
		for (let k = 0; k < tris.length && lit >= 0; k += 3) {
			const [a, b, c] = [ring[tris[k]!]!, ring[tris[k + 1]!]!, ring[tris[k + 2]!]!];
			const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
			for (let n = Math.floor(area / ROOF_M2 + random()) || (k === 0 && !lit ? 1 : 0); n > 0; n--, lit++) {
				let [s, t] = [random(), random()];
				if (s + t > 1) [s, t] = [1 - s, 1 - t];
				roofLights.push(a[0] + (b[0] - a[0]) * s + (c[0] - a[0]) * t, top + 1, a[1] + (b[1] - a[1]) * s + (c[1] - a[1]) * t);
			}
		}
	}

	if (!indices.length) return { materials: [], meshes: [], roofLights, windows };
	const mesh = new Mesh('buildings', scene);
	Object.assign(new VertexData(), { positions, normals, uvs, uvs2, colors, indices }).applyToMesh(mesh);
	mesh.freezeWorldMatrix();
	const material = new PBRMaterial('buildings', scene);
	material.albedoColor = new Color3(WHITE, WHITE, WHITE);
	material.emissiveTexture = litRooms(scene);
	material.emissiveColor = Color3.White();
	material.bumpTexture = facadeRelief(scene);
	material.bumpTexture.level = RELIEF;
	material.lightmapTexture = occlusion(scene);
	material.useLightmapAsShadowmap = true; // multiplies the lighting rather than adding to it
	// Shaded walls take the sky's light: the atmosphere writes it to scene.ambientColor, and a
	// PBR material's ambientColor (default black) multiplies it away.
	material.ambientColor = Color3.White();
	material.metallic = 0;
	material.roughness = 0.8;
	// ponytail: earcut's roof winding isn't checked against Babylon's; both sides drawn. Cull once verified.
	material.backFaceCulling = false;
	mesh.material = material;
	return { materials: [material], meshes: [mesh], roofLights, windows };
}

/**
 * The night: rooms lit in short runs along each floor (offices and flats alike),
 * warm sodium and white mostly, a few cool. 3 m cells, a dark gap between floors.
 */
function litRooms(scene: Scene) {
	const random = mulberry32(0xf4c4de);
	const tex = new DynamicTexture('buildings-lit', CELLS * CELL_PX, scene, true);
	tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
	const ctx = tex.getContext();
	ctx.fillStyle = '#000';
	ctx.fillRect(0, 0, CELLS * CELL_PX, CELLS * CELL_PX);
	const lamps = ['#ffb35c', '#ffd9a0', '#fff1d6', '#fff1d6', '#cfe0ff'];
	for (let row = 0; row < CELLS; row++) {
		let run = 0;
		for (let col = 0; col < CELLS; col++) {
			if (run <= 0 && random() < 0.12) run = 1 + Math.floor(random() * 5);
			if (run-- > 0) {
				ctx.fillStyle = lamps[Math.floor(random() * lamps.length)]!;
				ctx.fillRect(col * CELL_PX + 2, row * CELL_PX + 4, CELL_PX - 4, 8);
			}
		}
	}
	// The pools (canvas row 0 is the top of UV space): a lamp by the door washing up the wall,
	// brightest at the foot and gone by the eaves; and a soft patch for a lit terrace.
	const pool = (col: number, x: number, y: number, r: number, colour: string) => {
		ctx.fillStyle = '#000';
		ctx.fillRect(col * CELL_PX, 0, CELL_PX, CELL_PX);
		const g = ctx.createRadialGradient(col * CELL_PX + x, y, 0, col * CELL_PX + x, y, r);
		g.addColorStop(0, colour);
		g.addColorStop(1, '#000');
		ctx.fillStyle = g;
		ctx.fillRect(col * CELL_PX, 0, CELL_PX, CELL_PX);
	};
	pool(POOL.wall, CELL_PX / 2, CELL_PX, CELL_PX * 0.95, '#ffcf8a');
	pool(POOL.roof, CELL_PX / 2, CELL_PX / 2, CELL_PX * 0.45, '#ffe2b0');
	tex.update();
	return tex;
}

/**
 * The facade's relief as a tangent-space normal map: every cell's window (the
 * rectangle litRooms lights) sunk into the wall with a one-texel bevel. The grid
 * is symmetric top to bottom, so it lines up whichever way a texture flips. The
 * roof texel (a cell corner) is flat wall.
 */
function facadeRelief(scene: Scene) {
	const N = CELLS * CELL_PX;
	const N0 = CELLS * CELL_PX;
	const inPool = (x: number, y: number) => ((x % N0) + N0) % N0 >= POOL.roof * CELL_PX && [0, CELLS - 1].includes(Math.floor((((y % N0) + N0) % N0) / CELL_PX));
	const inWindow = (x: number, y: number) => {
		if (inPool(x, y)) return false; // the pool cells are plain wall and roof: flat
		const [cx, cy] = [((x % CELL_PX) + CELL_PX) % CELL_PX, ((y % CELL_PX) + CELL_PX) % CELL_PX];
		return cx >= 2 && cx < CELL_PX - 2 && cy >= 4 && cy < CELL_PX - 4;
	};
	const height = (x: number, y: number) => (inWindow(x, y) ? 0 : 1);
	const data = new Uint8Array(N * N * 4);
	for (let y = 0; y < N; y++) {
		for (let x = 0; x < N; x++) {
			const [dx, dy] = [height(x + 1, y) - height(x - 1, y), height(x, y + 1) - height(x, y - 1)];
			const len = Math.hypot(dx, dy, 1);
			data.set([128 - (127 * dx) / len, 128 - (127 * dy) / len, 128 + 127 / len, 255], (y * N + x) * 4);
		}
	}
	const tex = RawTexture.CreateRGBATexture(data, N, N, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
	tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
	return tex;
}

/** A 1×64 ramp, dark at the street and clear by AO_M up: the lightmap every wall shares. */
function occlusion(scene: Scene) {
	const tex = new DynamicTexture('building-ao', { width: 1, height: 64 }, scene, false);
	const ctx = tex.getContext();
	for (let y = 0; y < 64; y++) {
		const t = 1 - y / 63; // canvas row 0 is the top of the ramp (v = 1)
		const k = Math.round(255 * (0.45 + 0.55 * t * t * (3 - 2 * t)));
		ctx.fillStyle = `rgb(${k},${k},${k})`;
		ctx.fillRect(0, y, 1, 1);
	}
	tex.update();
	tex.coordinatesIndex = 1;
	tex.wrapU = tex.wrapV = Texture.CLAMP_ADDRESSMODE;
	return tex;
}
