/**
 * Reactive holder for the currently-mounted CesiumManager.
 *
 * CesiumViewer.svelte assigns `manager` on mount and clears it on destroy.
 * Scene effects that need Cesium (geo-positioned effects like car lights,
 * passing planes) subscribe to `activeCesium.manager` inside a $effect —
 * they mount their primitives when it becomes non-null, tear down on null.
 *
 * Module-level $state is intentional: CesiumViewer lives as a sibling of the
 * scene Compositor in the component tree, so Svelte context can't bridge
 * them. A single global reactive slot is the pragmatic answer, and since
 * SSR is disabled (kiosk-only) there's no cross-request contamination risk.
 */

import type * as CesiumType from 'cesium';
import type { Viewer } from 'cesium';
import type { CameraRead } from './camera-read';

/**
 * Minimal structural surface the holder needs: the viewer and the Cesium
 * namespace for native geo-effects, the plain camera read for mirrors.
 * `CesiumManager` satisfies this structurally, so this module no longer
 * imports the orchestrator — that edge was the
 * `active → compose → camera → active` import cycle (type-only, but
 * nothing reported it either way).
 */
export interface ActiveManager {
	getViewer(): Viewer;
	getCesium(): typeof CesiumType;
	getCameraRead(): CameraRead | null;
}

class ActiveCesium {
	manager = $state<ActiveManager | null>(null);
}
export const activeCesium = new ActiveCesium();
