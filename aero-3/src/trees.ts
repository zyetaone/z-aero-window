/**
 * Low-poly trees in the green of the real imagery around the pin: clumps of
 * crowns, cones and bushes wherever a Sentinel-2 pixel (~37 m) reads as
 * vegetation, tinted by that pixel. Thin instances, one draw call per shape. Placement
 * hashes the pixel, so every pane grows the same forest.
 */
import { Color3, Matrix, MeshBuilder, PBRMaterial, Quaternion, Vector3, type Scene } from '@babylonjs/core';
import { hash } from './math.ts';

const RADIUS_M = 9_000; // the orbit's reach: from cruise a tree is a few pixels, a clump a speckle of green
const STEP_M = 37; // one Sentinel-2 z12 pixel
const MAX_TREES = 30_000; // thin instances of 20-60-triangle shapes: ~1M triangles at the cap

export function trees(
	scene: Scene,
	center: [x: number, z: number],
	imagery: (x: number, z: number) => [number, number, number] | null,
	groundAt: (x: number, z: number) => number
) {
	// Three low-poly shapes, a few pixels tall from the window: a round crown, a cone, a low bush.
	// One draw call each (thin instances); a hash of the spot picks the shape, so panes agree.
	const shapes = [
		{ mesh: MeshBuilder.CreateIcoSphere('tree-crown', { radius: 0.5, subdivisions: 1, flat: true }, scene), share: 0.5, lift: 0.75, w: 0.8 },
		{ mesh: MeshBuilder.CreateCylinder('tree-cone', { height: 1, diameterTop: 0, diameterBottom: 1, tessellation: 5 }, scene), share: 0.3, lift: 0.5, w: 0.45 },
		{ mesh: MeshBuilder.CreateCylinder('tree-bush', { height: 1, diameterTop: 0.55, diameterBottom: 1, tessellation: 6 }, scene), share: 0.2, lift: 0.5, w: 1.3 }
	].map((shape) => ({ ...shape, matrices: [] as number[], colors: [] as number[] }));
	const [s, q, at] = [new Vector3(), Quaternion.Identity(), new Vector3()];
	const m = new Matrix();

	// Green pixels first, then a hashed keep-rate that fits the budget evenly: filling row by
	// row until MAX_TREES would give the south of the circle every tree and the north none.
	const green: [number, number, [number, number, number]][] = [];
	for (let dz = -RADIUS_M; dz < RADIUS_M; dz += STEP_M) {
		for (let dx = -RADIUS_M; dx < RADIUS_M; dx += STEP_M) {
			if (dx * dx + dz * dz > RADIUS_M * RADIUS_M) continue;
			const [x, z] = [center[0] + dx, center[1] + dz];
			const rgb = imagery(x, z);
			if (rgb && vegetation(...rgb)) green.push([x, z, rgb]);
		}
	}
	const keep = Math.min(1, MAX_TREES / (green.length * 3.5)); // 3.5 trees per cluster on average
	let count = 0;
	for (const [x, z, [pr, pg, pb]] of green) {
		const seed = Math.floor(x / STEP_M) * 73_856_093 ^ Math.floor(z / STEP_M) * 19_349_663;
		if (hash(seed + 0x7ee) > keep) continue;
		// A clump: 1-6 trees thrown around the pixel's centre, closer in than out.
		const n = 1 + Math.floor(hash(seed) * 6);
		for (let k = 0; k < n; k++) {
			const h = (seed + k * 7) | 0;
			const [a, r] = [hash(h + 1) * 2 * Math.PI, hash(h + 2) ** 1.5 * STEP_M * 0.9];
			const [tx, tz] = [x + STEP_M / 2 + Math.cos(a) * r, z + STEP_M / 2 + Math.sin(a) * r];
			const u = hash(h + 4);
			const shape = u < shapes[0]!.share ? shapes[0]! : u < shapes[0]!.share + shapes[1]!.share ? shapes[1]! : shapes[2]!;
			const tall = 5 + hash(h + 3) ** 2 * 18; // mostly small, a few big
			s.set(tall * shape.w, tall, tall * shape.w);
			Matrix.ComposeToRef(s, Quaternion.RotationYawPitchRollToRef(a, 0, 0, q), at.set(tx, groundAt(tx, tz) + tall * shape.lift - 1, tz), m);
			shape.matrices.push(...m.asArray());
			// Greens of the place: a base canopy green leaning 40% to the pixel it stands in, in linear light.
			const k2 = 0.7 + hash(h + 5) * 0.45;
			const lin = (c: number) => (c / 255) ** 2.2 * 1.4;
			shape.colors.push((0.6 * 0.15 + 0.4 * lin(pr)) * k2, (0.6 * 0.26 + 0.4 * lin(pg)) * k2, (0.6 * 0.1 + 0.4 * lin(pb)) * k2, 1);
			count++;
		}
	}

	const material = new PBRMaterial('trees', scene);
	material.albedoColor = Color3.White(); // the instance colour carries the green
	material.ambientColor = Color3.White(); // take the sky's light in shade (see buildings.ts)
	material.metallic = 0;
	material.roughness = 0.9;
	for (const { mesh, matrices, colors } of shapes) {
		mesh.material = material;
		mesh.isPickable = false;
		mesh.alwaysSelectAsActiveMesh = true; // the shape's own bounds sit at the origin
		if (!matrices.length) mesh.setEnabled(false);
		else {
			mesh.thinInstanceSetBuffer('matrix', new Float32Array(matrices), 16, true);
			mesh.thinInstanceSetBuffer('color', new Float32Array(colors), 4, true);
		}
	}
	return count;
}

/** Green dominant and not bright: canopy and lawns, not fields of dry grass or roofs. */
// Greener than blue by a margin: shallow teal sea (Dubai's coast) passes a looser test and grew a forest.
const vegetation = (r: number, g: number, b: number) => g > r * 1.04 && g > b * 1.2 && r + g + b < 330;
