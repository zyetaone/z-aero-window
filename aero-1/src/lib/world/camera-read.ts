/**
 * world/camera-read — plain camera-read shape, leaf module with zero imports.
 *
 * Lives apart from `camera.ts` so `active.svelte.ts` can type the manager
 * port without importing the orchestrator (`compose.ts`) or the camera
 * module (which reads `activeCesium` back — that round-trip was the
 * `active → compose → camera → active` import cycle). No Cesium types
 * leave the world layer through this shape.
 */
export interface CameraRead {
	position: { x: number; y: number; z: number };
	direction: { x: number; y: number; z: number };
	up: { x: number; y: number; z: number };
	fovDeg: number;
}
