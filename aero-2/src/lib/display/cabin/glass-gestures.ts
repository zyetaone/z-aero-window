/**
 * Gestures on the open glass: DRAG to look around, DOUBLE-TAP for the clock.
 *
 * One attachment on the display root, so the cabin chrome (drawer, HUD
 * buttons, the blind's own drag, the QR backdrop, the minimap) is excluded by
 * selector rather than by z-order juggling. A drag steers the SIMULATION
 * through `config.nudge`, exactly like LookControls: panning the map would be
 * undone on the next frame. Azimuth and pitch are pane knobs, so a drag aims
 * this pane only (the same property LookControls already has).
 *
 * Ported from the deleted `tap.ts` (aero-1 `use-tap.ts`): a tap is down+up
 * with under 12 px of travel inside 500 ms; two of them within 350 ms is a
 * double-tap. `pointercancel` (palm, scroll takeover) clears everything.
 */
import type { Attachment } from 'svelte/attachments';

const MOVE_TOLERANCE_PX = 12;
const MAX_PRESS_MS = 500;
const DOUBLE_TAP_MS = 350;
/** Degrees of azimuth per pixel of horizontal drag. */
const PAN_DEG_PER_PX = 0.08;
/** Degrees of pitch per pixel of vertical drag (drag down = look down). */
const PITCH_DEG_PER_PX = 0.05;

export interface GlassGestureOptions {
	onDoubleTap: () => void;
	/** Called per pointer move once a drag has begun, with the delta in degrees. */
	onLook: (azimuthDeg: number, pitchDeg: number) => void;
	/** Pointers starting inside a match are not glass gestures. */
	ignoreClosest: string;
}

export function glassGestures(opts: GlassGestureOptions): Attachment<HTMLElement> {
	return (node) => {
		let down = false;
		let dragging = false;
		let downX = 0;
		let downY = 0;
		let lastX = 0;
		let lastY = 0;
		let downAt = 0;
		let lastTapAt = -Infinity;

		const onPointerDown = (e: PointerEvent) => {
			if (e.isPrimary === false || (e.button ?? 0) > 0) return;
			if ((e.target as Element | null)?.closest?.(opts.ignoreClosest)) return;
			down = true;
			dragging = false;
			downX = lastX = e.clientX;
			downY = lastY = e.clientY;
			downAt = e.timeStamp;
		};
		const onPointerMove = (e: PointerEvent) => {
			if (!down) return;
			if (!dragging && Math.hypot(e.clientX - downX, e.clientY - downY) > MOVE_TOLERANCE_PX) {
				dragging = true;
				lastX = e.clientX;
				lastY = e.clientY;
				return;
			}
			if (!dragging) return;
			opts.onLook((e.clientX - lastX) * PAN_DEG_PER_PX, (lastY - e.clientY) * PITCH_DEG_PER_PX);
			lastX = e.clientX;
			lastY = e.clientY;
		};
		const onPointerUp = (e: PointerEvent) => {
			if (down && !dragging && e.timeStamp - downAt <= MAX_PRESS_MS) {
				if (e.timeStamp - lastTapAt <= DOUBLE_TAP_MS) {
					lastTapAt = -Infinity;
					opts.onDoubleTap();
				} else lastTapAt = e.timeStamp;
			}
			down = false;
			dragging = false;
		};
		const onPointerCancel = () => {
			down = false;
			dragging = false;
		};

		node.addEventListener('pointerdown', onPointerDown);
		node.addEventListener('pointermove', onPointerMove);
		node.addEventListener('pointerup', onPointerUp);
		node.addEventListener('pointercancel', onPointerCancel);
		return () => {
			node.removeEventListener('pointerdown', onPointerDown);
			node.removeEventListener('pointermove', onPointerMove);
			node.removeEventListener('pointerup', onPointerUp);
			node.removeEventListener('pointercancel', onPointerCancel);
		};
	};
}
