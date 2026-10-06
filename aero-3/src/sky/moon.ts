/**
 * The moon: a disc 600 km out along moonAt's direction, drawn after the sky
 * like the stars (the terrain's depth still hides it below the horizon). Its
 * phase is lit, not painted: each fragment is a point on a sphere facing the
 * eye, bright where it faces the sun, with faint earthshine on the rest. Drawn
 * 3.5× its true size, so a 0.5° moon still reads on a wall across a room.
 */
import { Constants, Effect, MeshBuilder, ShaderMaterial, Vector3, type Camera, type Scene } from '@babylonjs/core';
import { RAD, smoothstep } from '../math.ts';
import { moonAt } from './ephemeris.ts';

const DISTANCE_M = 600_000;
const SIZE_M = 2 * DISTANCE_M * Math.tan(0.26 * RAD) * 3.5;

Effect.ShadersStore.moonVertexShader = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 world;
uniform mat4 viewProjection;
uniform vec3 eye;
varying vec2 vUV;
varying vec3 vR, vU, vF;
void main() {
	vec4 wp = world * vec4(position, 1.0);
	gl_Position = viewProjection * wp;
	vUV = uv * 2.0 - 1.0;
	vR = normalize((world * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
	vU = normalize((world * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
	vF = normalize(eye - (world * vec4(0.0, 0.0, 0.0, 1.0)).xyz);
}`;
Effect.ShadersStore.moonFragmentShader = `
precision highp float;
uniform vec3 sun;
uniform float gain;
varying vec2 vUV;
varying vec3 vR, vU, vF;
void main() {
	float r2 = dot(vUV, vUV);
	if (r2 > 1.0) discard;
	vec3 n = normalize(vUV.x * vR + vUV.y * vU + sqrt(1.0 - r2) * vF);
	float lit = smoothstep(-0.04, 0.06, dot(n, sun));
	float maria = 0.8 + 0.2 * sin(vUV.x * 7.0 + 1.3) * sin(vUV.y * 6.0 - 0.7); // the darker seas, roughly
	float limb = 0.75 + 0.25 * sqrt(1.0 - r2);
	float edge = 1.0 - smoothstep(0.9, 1.0, r2);
	gl_FragColor = vec4(vec3(1.0, 0.97, 0.9) * (lit * maria * limb + 0.03) * edge * gain, 1.0);
}`;

export function createMoon(scene: Scene, camera: Camera, latDeg: number, lonDeg: number) {
	const disc = MeshBuilder.CreatePlane('moon', { size: SIZE_M, sideOrientation: 2 }, scene);
	const material = new ShaderMaterial('moon', scene, 'moon', {
		attributes: ['position', 'uv'],
		uniforms: ['world', 'viewProjection', 'eye', 'sun', 'gain'],
		needAlphaBlending: true
	});
	material.alphaMode = Constants.ALPHA_ONEONE; // gain lives in the colour: output clamps before blending
	material.disableDepthWrite = true;
	disc.material = material;
	disc.renderingGroupId = 1; // after the sky compositor, as the stars
	disc.isPickable = false;
	const toSun = new Vector3();

	return {
		/** `sun` is the unit vector to the sun; `dark` 0 by day, 1 at night. */
		update(ms: number, sun: { x: number; y: number; z: number }, dark: number) {
			const m = moonAt(ms, latDeg, lonDeg);
			// Faint by day, full at night, and gone into the haze at the horizon.
			const gain = (0.25 + 0.75 * dark) * smoothstep(-1, 5, m.elevationDeg);
			disc.setEnabled(gain > 0.01);
			if (gain <= 0.01) return;
			disc.position.set(camera.position.x + m.x * DISTANCE_M, camera.position.y + m.y * DISTANCE_M, camera.position.z + m.z * DISTANCE_M);
			disc.lookAt(camera.position);
			material.setVector3('eye', camera.position);
			material.setVector3('sun', toSun.set(sun.x, sun.y, sun.z));
			material.setFloat('gain', gain);
		}
	};
}
