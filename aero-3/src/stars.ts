/**
 * The night sky: aero-2's vendored Yale Bright Star Catalog as one point cloud,
 * turned by local sidereal time so the constellations stand where they do over
 * the place tonight. Points draw additively, so they fade into twilight rather
 * than punching dark dots in it, and the terrain's depth hides those below the
 * horizon.
 */
import { Color4, Constants, PointsCloudSystem, type Camera, type Scene } from '@babylonjs/core';
import { yaleCatalog } from '../../aero-2/src/lib/display/world/yale-stars.ts';
import { siderealDeg } from './sun.ts';

const RAD = Math.PI / 180;
const SKY_M = 800_000; // inside the camera's 1000 km far plane, past the horizon

export async function stars(scene: Scene, camera: Camera, latDeg: number, lonDeg: number) {
	const { ra, dec, vmag, bv } = yaleCatalog();
	const pcs = new PointsCloudSystem('stars', 2, scene);
	pcs.addPoints(ra.length, (p: { color: Color4 }, i: number) => {
		// Magnitude to brightness (each step ~2.5× dimmer), B-V to a blue-white-orange tint.
		const k = Math.min(1, 2.512 ** (1.5 - vmag[i]!)) ** 0.5;
		const t = Math.min(1, Math.max(0, (bv[i]! + 0.3) / 2));
		p.color = new Color4(k * (0.75 + 0.25 * t), k * (0.85 - 0.05 * t), k * (1 - 0.35 * t), 1);
	});
	const mesh = await pcs.buildMeshAsync();
	mesh.material!.alphaMode = Constants.ALPHA_ADD;
	mesh.material!.alpha = 0.999; // anything below 1 puts it in the blended pass
	mesh.isPickable = false;
	// Built with every point at the origin, so its bounding box is a dot inside the near plane: never cull it.
	mesh.alwaysSelectAsActiveMesh = true;
	mesh.renderingGroupId = 1; // after the sky compositor, which would otherwise paint over it
	const base = pcs.particles.map((p) => p.color!.clone());

	const lat = latDeg * RAD;
	let lst = 0;
	let brightness = 1;
	pcs.updateParticle = (p) => {
		const i = p.idx;
		// Equatorial (RA/Dec) to the scene's east/up/north via the hour angle.
		const h = lst - ra[i]! * RAD;
		const d = dec[i]! * RAD;
		const east = -Math.cos(d) * Math.sin(h);
		const north = Math.sin(d) * Math.cos(lat) - Math.cos(d) * Math.cos(h) * Math.sin(lat);
		const up = Math.sin(d) * Math.sin(lat) + Math.cos(d) * Math.cos(h) * Math.cos(lat);
		p.position.set(east * SKY_M, up * SKY_M, north * SKY_M);
		p.color!.copyFrom(base[i]!).scaleInPlace(brightness);
		return p;
	};

	let turnedAt = -Infinity;
	return {
		/** Turn the sky to `ms` (once a second is plenty) and fade it by `visible`. */
		update(ms: number, visible: number) {
			mesh.setEnabled(visible > 0.01);
			mesh.position.copyFrom(camera.position);
			if (Math.abs(ms - turnedAt) < 1000 && Math.abs(brightness - visible) < 0.02) return;
			[turnedAt, lst, brightness] = [ms, siderealDeg(ms, lonDeg) * RAD, visible];
			pcs.setParticles();
		}
	};
}
