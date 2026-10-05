/**
 * Streetlights as real points, not texels: one lamp every few tens of metres
 * along every road in the place's pack, drawn as a single point cloud.
 *
 * A baked lamp texture turns into blocky squares close up and smears at range;
 * a point is a crisp pixel at any distance, which is how a city reads from a
 * cruising window. The colour is aero-1's per-road deal — a hash of the road's
 * first vertex picks one lamp kind for the whole road, sodium-majority — so a
 * street reads as one string of light, not confetti. Babylon's GlowLayer
 * (main.ts) then blooms them, and the ground's VIIRS emissive stays underneath
 * as the faint carpet of everything the road pack leaves out.
 */
import { Color3, Constants, Mesh, StandardMaterial, VertexData, type Scene } from '@babylonjs/core';

type Road = { geometry: { coordinates: number[][] }; properties: { class: string } };

/** Metres between lamps, and how bright they read, by road class. */
const CLASS: Record<string, [spacing: number, gain: number]> = {
	motorway: [32, 1],
	trunk: [34, 1],
	primary: [36, 0.9],
	secondary: [40, 0.8],
	tertiary: [45, 0.7],
	residential: [55, 0.5]
};
// Sodium-majority, the way Indian and older US streets still mostly are.
const KINDS: [weight: number, colour: [number, number, number]][] = [
	[0.6, [1, 0.62, 0.25]],
	[0.25, [1, 0.85, 0.62]],
	[0.15, [0.82, 0.88, 1]]
];
const LAMP_HEIGHT_M = 10;

export function streetlights(
	roads: Road[],
	project: (lon: number, lat: number) => [x: number, z: number],
	groundAt: (x: number, z: number) => number,
	scene: Scene
) {
	const positions: number[] = [];
	const colors: number[] = [];

	for (const { geometry, properties } of roads) {
		const [spacing, gain] = CLASS[properties.class] ?? CLASS.residential!;
		const line = geometry.coordinates.map(([lon, lat]) => project(lon!, lat!));
		const [r, g, b] = kindFor(geometry.coordinates[0]!);
		let carry = 0; // distance into the current segment where the next lamp falls
		for (let i = 1; i < line.length; i++) {
			const [[x0, z0], [x1, z1]] = [line[i - 1]!, line[i]!];
			const len = Math.hypot(x1 - x0, z1 - z0);
			for (let d = carry; d < len; d += spacing) {
				const [x, z] = [x0 + ((x1 - x0) * d) / len, z0 + ((z1 - z0) * d) / len];
				positions.push(x, groundAt(x, z) + LAMP_HEIGHT_M, z);
				colors.push(r * gain, g * gain, b * gain, 1);
			}
			carry = (carry - len) % spacing;
			if (carry < 0) carry += spacing;
		}
	}

	const mesh = new Mesh('streetlights', scene);
	Object.assign(new VertexData(), { positions, colors }).applyToMesh(mesh);
	mesh.isPickable = false;
	mesh.freezeWorldMatrix();

	// Unlit, additive points: the vertex colour is the light. With lighting off, Babylon's
	// standard shader multiplies vertex colour into the EMISSIVE term, so emissive is white.
	const material = new StandardMaterial('streetlights', scene);
	material.disableLighting = true;
	material.emissiveColor = Color3.White();
	material.diffuseColor = Color3.Black();
	material.pointsCloud = true;
	material.pointSize = 2;
	material.alphaMode = Constants.ALPHA_ADD;
	material.disableDepthWrite = true;
	mesh.material = material;
	mesh.hasVertexAlpha = false;
	return { mesh, material, count: positions.length / 3 };
}

/** One lamp kind per road, from a hash of its first vertex: every pane deals the same. */
function kindFor([lon, lat]: number[]): [number, number, number] {
	const h = Math.abs(Math.sin(lon! * 12.9898 + lat! * 78.233) * 43_758.5453) % 1;
	let acc = 0;
	for (const [weight, colour] of KINDS) if (h < (acc += weight)) return colour;
	return KINDS[0]![1];
}
