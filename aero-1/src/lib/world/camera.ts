/**
 * world/camera — typed camera state + per-frame sync, split out of
 * CesiumManager so the world-boundary surface is plain numbers /
 * `Cesium.Cartesian3` rather than the orchestrator's class shape.
 *
 * Three-side consumers (CameraMirror, any future cloud/wing layer that
 * needs to mirror the camera) MUST go through this module's `getCameraRead()`
 * rather than reaching into `activeCesium.manager` directly.
 *
 * `syncCamera(slice, resources, scratchDest)` is the per-frame body that
 * CesiumManager previously owned as a `#syncCamera` method. Extracting it
 * keeps the orchestrator thin and gives tests a single seam: the function
 * is pure with respect to its arguments — pass a fabricated `slice` and a
 * mock viewer and you can drive the camera math without a Cesium instance.
 *
 * The scratch Cartesian3 is supplied by the caller because it must live for
 * the life of the per-frame tick (a per-call allocation would defeat the
 * "this is the hot path" reasoning the original inline code carried).
 */
import { SEAT_LOOK_DEG } from '$lib/flight/screen-conventions';
import type { Cartesian3, Viewer } from 'cesium';
import type * as CesiumType from 'cesium';
import { activeCesium } from './active.svelte';
import type { CameraRead } from './camera-read';

// Re-exported so existing `import ... from './camera'` / `$lib/world/camera`
// type imports keep working; the canonical home is `./camera-read`.
export type { CameraRead } from './camera-read';

/** The model fields the camera module reads. Narrower than CesiumModelView so
 * the orchestrator's full shape stays private. */
export interface CameraSyncSlice {
	flight: {
		camLon: number;
		camLat: number;
		camAlt: number;
		camHeading: number;
		camPitch: number;
	};
	motion: { bankAngle: number };
	config: {
		camera: {
			effectiveHeading(baseHeading: number): number;
			motion: { bankPitchCouple: number };
			flyoverPitchDeg: number;
		};
	};
}

/** Resources syncCamera needs that the module does NOT own (the live Cesium
 * runtime + the Viewer). Pass these in so the module has no global state. */
export interface CameraSyncResources {
	Cesium: typeof CesiumType;
	viewer: Viewer;
}

/**
 * Read the current Cesium camera as plain numbers. Null when no viewer is
 * mounted (page navigation, HMR, auto-retry).
 */
export function getCameraRead(): CameraRead | null {
	const mgr = activeCesium.manager;
	if (!mgr) return null;
	return mgr.getCameraRead();
}

/**
 * Per-frame camera sync body. Sets the Cesium camera destination + orientation
 * from the flight pose + parallax heading + seat-look + bank/pitch coupling.
 *
 * `scratchDest` is the work buffer; pass a single instance the caller owns
 * so this stays alloc-free in the tick.
 *
 * `camPitch` is measured from straight-down; Cesium's is from the horizon.
 * The -90 below is that frame conversion — NOT the seat-look yaw above,
 * which is a different 90 with a different meaning.
 */
export function syncCamera(
	slice: CameraSyncSlice,
	resources: CameraSyncResources,
	scratchDest: Cartesian3,
): void {
	const { Cesium: C, viewer } = resources;
	const f = slice.flight;
	const parallaxHeading = slice.config.camera.effectiveHeading(f.camHeading);
	C.Cartesian3.fromDegrees(f.camLon, f.camLat, f.camAlt * 0.3048, undefined, scratchDest);

	const bankPitchCouple = slice.config.camera.motion.bankPitchCouple ?? 0;
	const flyover = slice.config.camera.flyoverPitchDeg ?? 0;
	const pitchDeg = flyover !== 0
		? flyover - bankPitchCouple * slice.motion.bankAngle
		: (f.camPitch - 90) - bankPitchCouple * slice.motion.bankAngle;

	viewer.camera.setView({
		destination: scratchDest,
		orientation: {
			heading: C.Math.toRadians((parallaxHeading + SEAT_LOOK_DEG) % 360),
			pitch: C.Math.toRadians(pitchDeg),
			roll: C.Math.toRadians(-slice.motion.bankAngle),
		},
	});
}
