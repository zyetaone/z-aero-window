/**
 * OSM footprints extruded into one mesh: one draw call for the whole city.
 *
 * Built at boot from the GeoJSON `aero-2/tools/fetch-buildings.py` writes, so
 * there is no bake step and no tile format. 3D Tiles would add a traversal
 * library and per-frame tile selection on a CPU-bound Pi to stream geometry
 * that fits in one buffer; it earns its place for photogrammetry, not boxes.
 *
 * Flat-shaded: every wall quad and roof has its own vertices so the sun reads
 * on each face. Walls carry a procedural facade (windows on a 3 m grid) whose
 * lit cells are the night-time emissive, so a tower reads as floors of
 * windows by day and a scatter of lit rooms at night. Each building stands on
 * the terrain under its first corner.
 */
import earcut from 'earcut';
import { Color3, DynamicTexture, Mesh, PBRMaterial, Texture, VertexData, type Scene } from '@babylonjs/core';

type Footprint = { geometry: { coordinates: number[][][] }; properties: { height: number } };

const CELLS = 16; // windows per texture side
const CELL_PX = 16;
const FACADE_M = CELLS * 3; // one texture repeat is 16 windows of 3 m

export function buildings(
	features: Footprint[],
	project: (lon: number, lat: number) => [x: number, z: number],
	groundAt: (x: number, z: number) => number,
	scene: Scene
) {
	const positions: number[] = [];
	const normals: number[] = [];
	const uvs: number[] = [];
	const indices: number[] = [];
	const random = mulberry32(0xae3);

	for (const { geometry, properties } of features) {
		// GeoJSON closes the ring by repeating the first point; drop it.
		const ring = geometry.coordinates[0]!.slice(0, -1).map(([lon, lat]) => project(lon!, lat!));
		if (ring.length < 3) continue;
		const base = groundAt(...ring[0]!);
		const top = base + properties.height;
		const vTop = properties.height / FACADE_M;
		// A whole-window shift per building, so neighbours don't light the same rooms.
		const [u0, v0] = [Math.floor(random() * CELLS) / CELLS, Math.floor(random() * CELLS) / CELLS];

		// Shoelace sign: walls face outward whichever way OSM wound the ring.
		const area = ring.reduce((sum, [x, z], i) => {
			const [nx, nz] = ring[(i + 1) % ring.length]!;
			return sum + x * nz - nx * z;
		}, 0);
		const out = area > 0 ? 1 : -1;

		let along = u0;
		for (const [i, [x0, z0]] of ring.entries()) {
			const [x1, z1] = ring[(i + 1) % ring.length]!;
			const len = Math.hypot(x1 - x0, z1 - z0) || 1e-6;
			const [nx, nz] = [(out * (z1 - z0)) / len, (-out * (x1 - x0)) / len];
			const u1 = along + len / FACADE_M;
			const v = positions.length / 3;
			positions.push(x0, base, z0, x1, base, z1, x1, top, z1, x0, top, z0);
			uvs.push(along, v0, u1, v0, u1, v0 + vTop, along, v0 + vTop);
			for (let k = 0; k < 4; k++) normals.push(nx, 0, nz);
			indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
			along = u1;
		}

		const v = positions.length / 3;
		for (const [x, z] of ring) {
			positions.push(x, top, z);
			normals.push(0, 1, 0);
			uvs.push(u0 + 0.5 / (CELLS * CELL_PX), v0 + 0.5 / (CELLS * CELL_PX)); // a wall texel: roofs read as slab
		}
		for (const i of earcut(ring.flat())) indices.push(v + i);
	}

	const mesh = new Mesh('buildings', scene);
	Object.assign(new VertexData(), { positions, normals, uvs, indices }).applyToMesh(mesh);
	mesh.freezeWorldMatrix();

	const [albedo, lit] = facade(scene);
	const material = new PBRMaterial('buildings', scene);
	material.albedoTexture = albedo;
	material.emissiveTexture = lit;
	material.emissiveColor = Color3.White();
	material.metallic = 0;
	material.roughness = 0.85;
	// ponytail: earcut's roof winding isn't checked against Babylon's; both sides drawn. Cull once verified.
	material.backFaceCulling = false;
	mesh.material = material;
	return material;
}

/**
 * Two 256² tiles of the same window grid: concrete and dark glass for the day,
 * and the night's lit rooms — about a third, in sodium, warm and cool white.
 */
function facade(scene: Scene): [DynamicTexture, DynamicTexture] {
	const random = mulberry32(0xf4c4de);
	const [day, night] = ['facade', 'facade-lit'].map((name) => {
		const tex = new DynamicTexture(name, CELLS * CELL_PX, scene, true);
		tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
		return tex;
	}) as [DynamicTexture, DynamicTexture];
	const [dc, nc] = [day.getContext(), night.getContext()];
	dc.fillStyle = '#9b968c';
	dc.fillRect(0, 0, CELLS * CELL_PX, CELLS * CELL_PX);
	nc.fillStyle = '#000';
	nc.fillRect(0, 0, CELLS * CELL_PX, CELLS * CELL_PX);
	const lamps = ['#ffb35c', '#ffd9a0', '#fff1d6', '#cfe0ff'];
	for (let row = 0; row < CELLS; row++) {
		for (let col = 0; col < CELLS; col++) {
			const [x, y] = [col * CELL_PX + 3, row * CELL_PX + 4];
			dc.fillStyle = random() < 0.15 ? '#46505c' : '#2c3642';
			dc.fillRect(x, y, 10, 8);
			if (random() < 0.33) {
				nc.fillStyle = lamps[Math.floor(random() * lamps.length)]!;
				nc.fillRect(x, y, 10, 8);
			}
		}
	}
	day.update();
	night.update();
	return [day, night];
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
