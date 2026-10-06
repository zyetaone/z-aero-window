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
 * Buildings add lit windows and (on about half of them) a roof light, and the
 * towns past the road pack come as clusters from NASA's VIIRS radiance
 * (ground/maps.ts). Lit roads break into stretches by their own seeded noise.
 *
 * One small shader does what an unlit material cannot: each light dims with
 * distance, fading out and reddening toward the horizon (no atmosphere touches unlit points,
 * so far motorways otherwise blaze as bright as the core), and twinkles faintly
 * at its own slow rate, the scintillation a city shows through 3 km of warm air. All of it runs off wall-clock seconds: panes agree.
 */
import { Constants } from '@babylonjs/core/Engines/constants';
import { Effect } from '@babylonjs/core/Materials/effect';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { Scene } from '@babylonjs/core/scene';
import { hash, noise1 } from '#math.ts';
import type { Road } from '#world/ground/maps.ts';


/** Metres between lamps, how bright they read, and the share of roads lit, by road class. */
const CLASS: Record<string, [spacing: number, gain: number, litShare: number]> = {
	motorway: [32, 1, 0.97],
	trunk: [34, 1, 0.95],
	primary: [36, 0.9, 0.9],
	secondary: [40, 0.8, 0.85],
	tertiary: [45, 0.7, 0.7],
	residential: [55, 0.5, 0.5]
};
const GAP_M = 350; // the scale of the dark stretches along a lit road
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
uniform vec3 groups; // gains for streets, buildings, far towns (the Lights panel)
varying vec3 vColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
	gl_Position = worldViewProjection * vec4(position, 1.0);
	gl_PointSize = 3.0; // a soft disc (fragment shader), not a hard square: it slides between pixels instead of snapping
	float h = hash(floor(position.xz));
	float far = 1.0 / (1.0 + pow(distance(position, eye) / fade, 2.0));
	float twinkle = 0.92 + 0.08 * sin(time * (0.4 + 1.2 * h) + h * 6.2832);
	// Haze dims distant lights and reddens them: blue scatters out of the path first.
	vec3 hazed = mix(color.rgb * vec3(1.0, 0.72, 0.45), color.rgb, far);
	// colour.a carries the group: 1 street, 2 building, 3 far town.
	float group = color.a < 1.5 ? groups.x : color.a < 2.5 ? groups.y : groups.z;
	vColor = hazed * far * twinkle * group;
}`;
Effect.ShadersStore.lampsFragmentShader = `
precision highp float;
uniform float gain;
varying vec3 vColor;
void main() {
	float r = length(gl_PointCoord - 0.5) * 2.0;
	gl_FragColor = vec4(vColor * gain * 1.7 * (1.0 - smoothstep(0.2, 1.0, r)), 1.0); // 1.7: the disc's light matches the old 2x2 square
}`;

export function createLights(
	roads: Road[],
	project: (lon: number, lat: number) => [x: number, z: number],
	groundAt: (x: number, z: number) => number,
	scene: Scene,
	/** Lights on the flat roofs: flat [x, y, z] (city/buildings.ts). */
	roofs: number[] = [],
	/** VIIRS-derived towns and villages: flat [x, y, z, radiance] (ground/terrain.ts lightSites). */
	sites: number[] = [],
	/** Lit windows on building walls: flat [x, y, z] (city/buildings.ts). */
	windows: number[] = []
) {
	const positions: number[] = [];
	const colors: number[] = [];

	for (const { geometry, properties } of roads) {
		const [spacing, gain, litShare] = CLASS[properties.class] ?? CLASS.residential!;
		const [lon0, lat0] = geometry.coordinates[0]!;
		const seed = (Math.floor(lon0! * 1e5) * 73_856_093) ^ (Math.floor(lat0! * 1e5) * 19_349_663);
		if (hash(seed) > litShare) continue; // not every road is lit: the back streets go dark
		const line = geometry.coordinates.map(([lon, lat]) => project(lon!, lat!));
		const [r, g, b] = kindFor(geometry.coordinates[0]!);
		let carry = 0; // distance into the current segment where the next lamp falls
		let run = 0; // distance along the whole road, for the gap noise
		for (let i = 1; i < line.length; i++) {
			const [[x0, z0], [x1, z1]] = [line[i - 1]!, line[i]!];
			const len = Math.hypot(x1 - x0, z1 - z0);
			for (let d = carry; d < len; d += spacing) {
				// Dark stretches where the road's own 1D noise dips: a broken string, not a solid line.
				if (noise1(seed, (run + d) / GAP_M) < 0.28) continue;
				const v = hash(seed + Math.floor(run + d));
				if (v < 0.02) continue; // the odd lamp out
				const k = gain * (0.55 + 0.6 * v); // and no two quite alike
				const [x, z] = [x0 + ((x1 - x0) * d) / len, z0 + ((z1 - z0) * d) / len];
				positions.push(x, groundAt(x, z) + LAMP_HEIGHT_M, z);
				colors.push(r * k, g * k, b * k, 1);
			}
			run += len;
			carry = (carry - len) % spacing;
			if (carry < 0) carry += spacing;
		}
	}

	// Roof lights, dealt from the same mix by hash, dimmer than the streets.
	for (let i = 0; i < roofs.length; i += 3) {
		const [r, g, b] = kindFor([roofs[i]!, roofs[i + 2]!]);
		positions.push(roofs[i]!, roofs[i + 1]!, roofs[i + 2]!);
		colors.push(r * 0.45, g * 0.45, b * 0.45, 2);
	}

	// Lit rooms: warm, mostly, with the odd cool screen-lit one.
	for (let i = 0; i < windows.length; i += 3) {
		const cool = (i / 3) % 7 === 0;
		positions.push(windows[i]!, windows[i + 1]!, windows[i + 2]!);
		colors.push(cool ? 0.45 : 0.68, cool ? 0.52 : 0.47, cool ? 0.68 : 0.22, 2);
	}

	// Far towns, dealt from the same mix, brighter where NASA measured more light.
	for (let i = 0; i < sites.length; i += 4) {
		const [r, g, b] = kindFor([sites[i]!, sites[i + 2]!]);
		const k = (0.5 + 0.5 * sites[i + 3]!) * 0.55; // fainter than the city: they are far and small
		positions.push(sites[i]!, sites[i + 1]!, sites[i + 2]!);
		colors.push(r * k, g * k, b * k, 3);
	}

	// Additive points, the night gain folded into the colour.
	const material = new ShaderMaterial('lamps', scene, 'lamps', {
		attributes: ['position', 'color'],
		uniforms: ['worldViewProjection', 'eye', 'time', 'fade', 'gain', 'groups'],
		needAlphaBlending: true
	});
	material.pointsCloud = true;
	material.alphaMode = Constants.ALPHA_ONEONE;
	material.disableDepthWrite = true;
	material.backFaceCulling = false;
	material.setFloat('fade', FADE_M);

	const groupGains = new Vector3();
	const mesh = new Mesh('streetlights', scene);
	Object.assign(new VertexData(), { positions, colors }).applyToMesh(mesh);
	mesh.isPickable = false;
	mesh.freezeWorldMatrix();
	mesh.material = material;

	return {
		mesh,
		/** Per-group gains from the Lights panel: streets, buildings, far towns. */
		update(eye: Vector3, nowMs: number, gain: number, groups: { street: number; building: number; far: number }) {
			material.setVector3('groups', groupGains.set(groups.street, groups.building, groups.far));
			material.setVector3('eye', eye);
			material.setFloat('time', (nowMs / 1000) % 86_400); // a day keeps float32 to ~8 ms; one wrap at UTC midnight
			material.setFloat('gain', gain);
			mesh.setEnabled(gain > 0.002);
		}
	};
}

/** One lamp kind per road, from a hash of its first vertex: every pane deals the same. */
/** A lamp colour by weight, picked by where it stands (any two coordinates, rounded to a metre's worth). */
function kindFor([a, b]: number[]): [number, number, number] {
	const h = hash(Math.imul(Math.round(a! * 1e5), 0x27d4eb2d) ^ Math.round(b! * 1e5));
	let acc = 0;
	for (const [weight, colour] of KINDS) if (h < (acc += weight)) return colour;
	return KINDS[0]![1];
}
