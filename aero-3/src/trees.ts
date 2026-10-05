/**
 * Low-poly trees in the green of the real imagery around the pin: clusters of
 * cones wherever a Sentinel-2 pixel (~37 m) reads as vegetation. One cone mesh
 * drawn as thin instances, so ten thousand trees are one draw call. Placement
 * hashes the pixel, so every pane grows the same forest.
 */
import { Color3, Matrix, MeshBuilder, PBRMaterial, Quaternion, Vector3, type Scene } from '@babylonjs/core';
import { hash } from './math.ts';

const RADIUS_M = 5_000; // trees beyond this are under a pixel from the window
const STEP_M = 37; // one Sentinel-2 z12 pixel
const MAX_TREES = 12_000;

export function trees(
	scene: Scene,
	center: [x: number, z: number],
	imagery: (x: number, z: number) => [number, number, number] | null,
	groundAt: (x: number, z: number) => number
) {
	const matrices: number[] = [];
	const colors: number[] = [];
	const [s, q, at] = [new Vector3(), Quaternion.Identity(), new Vector3()];
	const m = new Matrix();

	// Green pixels first, then a hashed keep-rate that fits the budget evenly: filling row by
	// row until MAX_TREES would give the south of the circle every tree and the north none.
	const green: [number, number][] = [];
	for (let dz = -RADIUS_M; dz < RADIUS_M; dz += STEP_M) {
		for (let dx = -RADIUS_M; dx < RADIUS_M; dx += STEP_M) {
			if (dx * dx + dz * dz > RADIUS_M * RADIUS_M) continue;
			const [x, z] = [center[0] + dx, center[1] + dz];
			const rgb = imagery(x, z);
			if (rgb && vegetation(...rgb)) green.push([x, z]);
		}
	}
	const keep = Math.min(1, MAX_TREES / (green.length * 2.5)); // 2.5 trees per cluster on average
	for (const [x, z] of green) {
		const seed = Math.floor(x / STEP_M) * 73_856_093 ^ Math.floor(z / STEP_M) * 19_349_663;
		if (hash(seed + 0x7ee) > keep) continue;
		const n = 1 + Math.floor(hash(seed) * 4); // a cluster of 1-4
		for (let k = 0; k < n; k++) {
			const [tx, tz] = [x + hash(seed + k * 3 + 1) * STEP_M, z + hash(seed + k * 3 + 2) * STEP_M];
			const h = 8 + hash(seed + k * 3 + 3) * 10;
			s.set(h * 0.45, h, h * 0.45);
			Matrix.ComposeToRef(s, q, at.set(tx, groundAt(tx, tz) + h / 2, tz), m);
			matrices.push(...m.asArray());
			const shade = 0.75 + hash(seed + k) * 0.35;
			colors.push(0.16 * shade, 0.27 * shade, 0.12 * shade, 1);
		}
	}

	// A five-sided cone, unit height: low-poly on purpose, it is a few pixels tall.
	const tree = MeshBuilder.CreateCylinder('trees', { height: 1, diameterTop: 0, diameterBottom: 1, tessellation: 5 }, scene);
	const material = new PBRMaterial('trees', scene);
	material.albedoColor = Color3.White(); // the instance colour carries the green
	material.metallic = 0;
	material.roughness = 0.9;
	tree.material = material;
	tree.isPickable = false;
	tree.thinInstanceSetBuffer('matrix', new Float32Array(matrices), 16, true);
	tree.thinInstanceSetBuffer('color', new Float32Array(colors), 4, true);
	tree.alwaysSelectAsActiveMesh = true; // the cone's own bounds sit at the origin
	return colors.length / 4;
}

/** Green dominant and not bright: canopy and lawns, not fields of dry grass or roofs. */
const vegetation = (r: number, g: number, b: number) => g > r * 1.04 && g > b * 1.08 && r + g + b < 330;
