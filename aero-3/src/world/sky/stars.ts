/**
 * The night sky: aero-2's vendored Yale Bright Star Catalog as one point cloud,
 * turned by local sidereal time so the constellations stand where they do over
 * the place tonight. Points draw additively, so they fade into twilight rather
 * than punching dark dots in it, and the terrain's depth hides those below the
 * horizon.
 */
import { mulberry32, noise1, RAD } from '#math.ts';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import { Constants } from '@babylonjs/core/Engines/constants';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { PointsCloudSystem } from '@babylonjs/core/Particles/pointsCloudSystem';
import type { Scene } from '@babylonjs/core/scene';
import { yaleCatalog } from './star-catalogue.ts';
import { siderealDeg } from './ephemeris.ts';

const SKY_M = 800_000; // inside the camera's 1000 km far plane, past the horizon

const MILKY_WAY_POINTS = 9_000;

/**
 * The Milky Way as a grain of faint points along the galactic plane (aero-2's wash, as points so
 * it rides in the one star mesh): longitude anywhere, latitude heaped within a few degrees, brighter
 * toward the bulge at the centre and broken by dark lanes. Returns RA and Dec in degrees, plus a
 * brightness, in equatorial coordinates via the galactic pole (RA 192.86°, Dec 27.13°).
 */
function milkyWay(seed: number) {
	const r = mulberry32(seed);
	const [raG, decG, lNcp] = [192.85948 * RAD, 27.12825 * RAD, 122.932 * RAD];
	const out = { ra: new Float32Array(MILKY_WAY_POINTS), dec: new Float32Array(MILKY_WAY_POINTS), k: new Float32Array(MILKY_WAY_POINTS) };
	for (let i = 0; i < MILKY_WAY_POINTS; i++) {
		const l = 2 * Math.PI * r();
		const b = (r() + r() + r() - 1.5) * 9 * RAD; // ~±7° either side, heaped on the plane
		const d = lNcp - l;
		const sinDec = Math.sin(decG) * Math.sin(b) + Math.cos(decG) * Math.cos(b) * Math.cos(d);
		out.dec[i] = Math.asin(sinDec) / RAD;
		out.ra[i] = ((raG + Math.atan2(Math.cos(b) * Math.sin(d), Math.cos(decG) * Math.sin(b) - Math.sin(decG) * Math.cos(b) * Math.cos(d))) / RAD + 360) % 360;
		const off = (((l + Math.PI) % (2 * Math.PI)) - Math.PI) / (50 * RAD); // longitude from the galactic centre, in bulge widths
		const bulge = 0.5 + 0.5 * Math.exp(-(off * off));
		out.k[i] = 0.16 * bulge * (0.4 + 0.6 * noise1(seed, l * 12)); // dark lanes along the band
	}
	return out;
}

export async function createStars(scene: Scene, camera: Camera, latDeg: number, lonDeg: number) {
	const yale = yaleCatalog();
	const galaxy = milkyWay(0x9a1ac);
	const ra = Float32Array.from([...yale.ra, ...galaxy.ra]);
	const dec = Float32Array.from([...yale.dec, ...galaxy.dec]);
	const pcs = new PointsCloudSystem('stars', 2, scene);
	pcs.addPoints(ra.length, (p: { color: Color4 }, i: number) => {
		if (i >= yale.ra.length) {
			const k = galaxy.k[i - yale.ra.length]!; // the galaxy's grain: faint and warm
			p.color = new Color4(k, k * 0.95, k * 0.85, 1);
			return;
		}
		// Magnitude to brightness (each step ~2.5× dimmer), B-V to a blue-white-orange tint.
		const [vmag, bv] = [yale.vmag[i]!, yale.bv[i]!];
		const k = Math.min(1, 2.512 ** (1.5 - vmag)) ** 0.5;
		const t = Math.min(1, Math.max(0, (bv + 0.3) / 2));
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
