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
 *
 * Every OSM building adds one light of its own on the roof, and the towns past
 * the road pack come as clusters from NASA's VIIRS radiance (world.ts) — map
 * data only, no invented noise.
 *
 * One small shader does what an unlit material cannot: each light dims with
 * distance, fading out toward the horizon (no atmosphere touches unlit points,
 * so far motorways otherwise blaze as bright as the core), and twinkles faintly
 * at its own slow rate, the scintillation a city shows through 3 km of warm air. All of it runs off wall-clock seconds: panes agree.
 */
import { Constants, Effect, Mesh, ShaderMaterial, VertexData, type Scene, type Vector3 } from '@babylonjs/core';

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
// Sodium-majority, the way Indian and older US streets still mostly are, with a few
// signal reds and blue-white LEDs.
const KINDS: [weight: number, colour: [number, number, number]][] = [
	[0.65, [1, 0.62, 0.25]], // sodium
	[0.15, [1, 0.85, 0.62]], // warm white
	[0.1, [1, 1, 1]], // white
	[0.05, [1, 0.12, 0.08]], // red
	[0.05, [0.45, 0.6, 1]] // blue
];
const LAMP_HEIGHT_M = 10;
const FADE_M = 18_000; // a lamp this far away reads half as bright

Effect.ShadersStore.lampsVertexShader = `
precision highp float;
attribute vec3 position;
attribute vec4 color;
uniform mat4 worldViewProjection;
uniform vec3 eye;
uniform float time;
uniform float fade;
varying vec3 vColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
	gl_Position = worldViewProjection * vec4(position, 1.0);
	gl_PointSize = 2.0;
	float h = hash(floor(position.xz));
	float far = 1.0 / (1.0 + pow(distance(position, eye) / fade, 2.0));
	float twinkle = 0.92 + 0.08 * sin(time * (0.4 + 1.2 * h) + h * 6.2832);
	vColor = color.rgb * far * twinkle;
}`;
Effect.ShadersStore.lampsFragmentShader = `
precision highp float;
uniform float gain;
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor * gain, 1.0); }`;

export function streetlights(
	roads: Road[],
	project: (lon: number, lat: number) => [x: number, z: number],
	groundAt: (x: number, z: number) => number,
	scene: Scene,
	/** Building roofs: [x, roof y, z, height]; one light each. */
	roofs: [number, number, number, number][] = [],
	/** Far-ring towns: flat [x, y, z, radiance] (world.ts lightSites). */
	sites: number[] = []
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

	// One light per building, dealt from the same mix by hash.
	for (const [x, y, z] of roofs) {
		const [r, g, b] = kindFor([x, z]);
		positions.push(x, y + 1, z);
		colors.push(r * 0.6, g * 0.6, b * 0.6, 1);
	}

	// Far towns, dealt from the same mix, brighter where NASA measured more light.
	for (let i = 0; i < sites.length; i += 4) {
		const [r, g, b] = kindFor([sites[i]!, sites[i + 2]!]);
		const k = 0.5 + 0.5 * sites[i + 3]!;
		positions.push(sites[i]!, sites[i + 1]!, sites[i + 2]!);
		colors.push(r * k, g * k, b * k, 1);
	}

	// Additive points, the night gain folded into the colour.
	const material = new ShaderMaterial('lamps', scene, 'lamps', {
		attributes: ['position', 'color'],
		uniforms: ['worldViewProjection', 'eye', 'time', 'fade', 'gain'],
		needAlphaBlending: true
	});
	material.pointsCloud = true;
	material.alphaMode = Constants.ALPHA_ONEONE;
	material.disableDepthWrite = true;
	material.backFaceCulling = false;
	material.setFloat('fade', FADE_M);

	const mesh = new Mesh('streetlights', scene);
	Object.assign(new VertexData(), { positions, colors }).applyToMesh(mesh);
	mesh.isPickable = false;
	mesh.freezeWorldMatrix();
	mesh.material = material;

	return {
		mesh,
		count: positions.length / 3,
		update(eye: Vector3, nowMs: number, gain: number) {
			material.setVector3('eye', eye);
			material.setFloat('time', (nowMs / 1000) % 86_400); // a day keeps float32 to ~8 ms; one wrap at UTC midnight
			material.setFloat('gain', gain);
			mesh.setEnabled(gain > 0.002);
		}
	};
}

/** One lamp kind per road, from a hash of its first vertex: every pane deals the same. */
function kindFor([lon, lat]: number[]): [number, number, number] {
	const h = Math.abs(Math.sin(lon! * 12.9898 + lat! * 78.233) * 43_758.5453) % 1;
	let acc = 0;
	for (const [weight, colour] of KINDS) if (h < (acc += weight)) return colour;
	return KINDS[0]![1];
}
