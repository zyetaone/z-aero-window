/**
 * OSM footprints extruded into one mesh: one draw call for the whole city.
 *
 * Built at boot from the GeoJSON `aero-2/tools/fetch-buildings.py` writes, so
 * there is no bake step and no tile format. 3D Tiles would add a traversal
 * library and per-frame tile selection on a CPU-bound Pi to stream geometry
 * that fits in one buffer; it earns its place for photogrammetry, not boxes.
 *
 * Flat-shaded: every wall quad and roof has its own vertices so the sun reads
 * on each face. Each building stands on the terrain under its first corner.
 */
import earcut from 'earcut';
import { Mesh, VertexData, type Scene } from '@babylonjs/core';

type Footprint = { geometry: { coordinates: number[][][] }; properties: { height: number } };

export function buildings(
	features: Footprint[],
	project: (lon: number, lat: number) => [x: number, z: number],
	groundAt: (x: number, z: number) => number,
	scene: Scene
): Mesh {
	const positions: number[] = [];
	const normals: number[] = [];
	const indices: number[] = [];

	for (const { geometry, properties } of features) {
		// GeoJSON closes the ring by repeating the first point; drop it.
		const ring = geometry.coordinates[0]!.slice(0, -1).map(([lon, lat]) => project(lon!, lat!));
		if (ring.length < 3) continue;
		const base = groundAt(...ring[0]!);
		const top = base + properties.height / 1000;

		// Shoelace sign: walls face outward whichever way OSM wound the ring.
		const area = ring.reduce((sum, [x, z], i) => {
			const [nx, nz] = ring[(i + 1) % ring.length]!;
			return sum + x * nz - nx * z;
		}, 0);
		const out = area > 0 ? 1 : -1;

		for (const [i, [x0, z0]] of ring.entries()) {
			const [x1, z1] = ring[(i + 1) % ring.length]!;
			const len = Math.hypot(x1 - x0, z1 - z0) || 1;
			const [nx, nz] = [(out * (z1 - z0)) / len, (-out * (x1 - x0)) / len];
			const v = positions.length / 3;
			positions.push(x0, base, z0, x1, base, z1, x1, top, z1, x0, top, z0);
			for (let k = 0; k < 4; k++) normals.push(nx, 0, nz);
			indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
		}

		const v = positions.length / 3;
		for (const [x, z] of ring) {
			positions.push(x, top, z);
			normals.push(0, 1, 0);
		}
		for (const i of earcut(ring.flat())) indices.push(v + i);
	}

	const mesh = new Mesh('buildings', scene);
	Object.assign(new VertexData(), { positions, normals, indices }).applyToMesh(mesh);
	return mesh;
}
