/**
 * starfield — pure math for the in-map night star layer.
 *
 * WHY THIS EXISTS: stars used to be a DOM overlay above the map canvas, kept
 * off the ground by a straight screen-space mask line. That breaks two ways:
 * terrain relief pokes above any flat line, and camera roll tilts the rendered
 * horizon away from the mask. The proper home (verified against the MapLibre
 * v6.6.0 sources we ship) is a `custom` style layer with `renderingMode:
 * '3d'`: it renders inside the map's GL context, shares the depth buffer with
 * the terrain (same `depthRangeFor3D` range — directly comparable, not sliced),
 * and positions via the injected `projectTileWithElevation` prelude, which
 * exists in BOTH the globe and mercator shader variants and clips
 * behind-horizon geometry for free.
 *
 * This module holds everything unit-testable: the deterministic star
 * population (same seed → same sky on every pane of the wall) and the shell
 * elevation guard. GL lives in `Starfield.svelte`; nothing here touches it.
 */

import { YALE_STAR_COUNT, yaleCatalog } from './yale-stars.js';

/**
 * How many lamp-points the night shell holds: the whole Yale Bright Star
 * Catalog at Vmag ≤ 6.5. Re-exported under the old name so the GL layer
 * keeps drawing `STAR_COUNT` points without knowing what they are.
 */
export const STAR_COUNT = YALE_STAR_COUNT;

/**
 * Celestial shell height, metres above the ellipsoid.
 *
 * The shell has to be far compared with the Earth's radius or the DIRECTION to
 * each star is wrong, because a star's apparent altitude is set by the geometry
 * of a finite sphere, not by astronomy. At shell radius r = (R + h) / R the
 * whole sky folds into a cap of half-angle acos(R / r) around the zenith:
 *
 *     shell          r       worst direction error over altitudes 5°–85°
 *     188 km      1.03 R                 76.5°
 *       2,000 km  1.31 R                 49.7°
 *      60,000 km  10.4 R                  5.5°
 *   2,000,000 km   315 R                  0.18°
 *
 * 2,000,000 km is chosen so the residual sits an order of magnitude under the
 * 1.4° of J2000 precession that `yale-stars.ts` argues is already invisible at
 * this stylization. Below that the two modules contradict each other.
 *
 * Distance costs nothing: the vertex shader pins every point to just inside the
 * far plane (skybox trick), because the camera far plane here is ~750 km while
 * the sky in frame is far beyond it laterally — projected honestly, everything
 * past far clips silently. Only x/y survive, and x/y is the direction.
 *
 * ponytail: a calibration knob, not a derivation. Raising it always helps and
 * saturates; if `projectTileWithElevation` ever misbehaves at this magnitude,
 * lower it and accept the error from the table rather than reinstating a clamp.
 */
export const STAR_SHELL_M = 2_000_000_000;

/**
 * Shell elevation, with a fallback for a missing `farZ`.
 *
 * This used to return `Math.min(STAR_SHELL_M, farZ * 0.25)`, described as "a
 * sanity bound so a wild farZ cannot tilt the directions". For the constant to
 * win, `farZ` would have had to exceed 8,000 km; this module's own docstring
 * says it is ~750 km and shrinks further in the close-up view. So the bound was
 * the operative value on every frame, the named constant was dead, and the
 * shell sat at 188 km — where a star meant for 60° above the horizon renders at
 * −12°, below it, hidden by the ground photograph. A sanity bound that had
 * quietly become the setting.
 *
 * `farZ` cannot tilt anything: the shader keeps only x/y and substitutes its
 * own z. So the argument is unused, kept for the call site's shape.
 */
export function starShellElevation(farZ: number): number {
	void farZ;
	return STAR_SHELL_M;
}

export interface StarField {
	/** World-mercator x/y in 0..1, one pair per star. */
	xy: Float32Array;
	/** Pixel size at 1x, roughly 0.9..3.2 — bright stars draw bigger. */
	size: Float32Array;
	/** Base opacity 0.3..1. */
	mag: Float32Array;
	/** Twinkle phase in radians. */
	phase: Float32Array;
	/** Effective temperature in Kelvin, from B-V — drives the tint. */
	temp: Float32Array;
}

/**
 * B-V colour index → effective temperature (Ballesteros 2012 fit).
 * Clamped to the range the fragment shader's tint approximation is built
 * for; outside it a star is either vanishingly dim or unphysical here.
 */
export function bvToTemp(bv: number): number {
	const c = Math.max(-0.4, Math.min(2.0, bv));
	const t = 4600 * (1 / (0.92 * c + 1.7) + 1 / (0.92 * c + 0.62));
	return Math.max(2500, Math.min(30000, t));
}

/**
 * lng/lat → world mercator 0..1, latitudes clamped to ±85.05° (mercator is
 * singular at the poles; the sun and moon never go there anyway).
 * Shared by the star builder above and the sun/moon disc layer.
 */
export function lngLatToMercator01(lng: number, lat: number): [number, number] {
	const x = (((lng + 180) / 360) % 1 + 1) % 1;
	const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
	const rad = (clampedLat * Math.PI) / 180;
	const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
	return [x, Math.max(0, Math.min(1, y))];
}

/**
 * The real sky: Yale Bright Star Catalog positions, magnitudes, colours.
 *
 * RA/Dec (J2000) → world mercator 0..1 with the same ±85.05° clamp as the
 * minimap projector — mercator is singular at the poles and no window looks
 * there anyway. Size and opacity come from the visual magnitude; tint comes
 * from B-V via {@link bvToTemp}. Twinkle phase is a per-index hash, not an
 * RNG stream, so it cannot depend on catalogue order or build sequence.
 *
 * Same bytes on every pane → identical buffers → the wall agrees star for
 * star. Deliberately NOT sidereal-rotated: the shell is fixed in world
 * space, so constellations hold still all night. True earth-rotation drift
 * is checkpoint 3, and needs a wall-agreed sidereal uniform first.
 */
export function buildStarField(): StarField {
	const cat = yaleCatalog();
	const xy = new Float32Array(STAR_COUNT * 2);
	const size = new Float32Array(STAR_COUNT);
	const mag = new Float32Array(STAR_COUNT);
	const phase = new Float32Array(STAR_COUNT);
	const temp = new Float32Array(STAR_COUNT);

	for (let i = 0; i < STAR_COUNT; i++) {
		const [mx, my] = lngLatToMercator01(cat.ra[i] - 180, cat.dec[i]);
		xy[i * 2] = mx;
		xy[i * 2 + 1] = my;

		const v = cat.vmag[i];
		size[i] = Math.max(0.9, Math.min(3.2, 2.9 - 0.28 * v));
		mag[i] = Math.max(0.3, Math.min(1, 1.15 - 0.11 * v));
		const h = Math.sin(i * 127.1) * 43758.5453;
		phase[i] = (h - Math.floor(h)) * Math.PI * 2;
		temp[i] = bvToTemp(cat.bv[i]);
	}
	return { xy, size, mag, phase, temp };
}
