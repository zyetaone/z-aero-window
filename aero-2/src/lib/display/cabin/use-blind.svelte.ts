/**
 * useBlind — Svelte 5 composable for the airplane window blind drag/snap controller.
 *
 * Encapsulates all blind state, derived values, and pointer/keyboard
 * handlers. Consumer mounts the controller via `{@attach blind.attach}` on
 * the clip element and wires the pointer handlers on the draggable overlay.
 */

import type { Attachment } from 'svelte/attachments';
import type { AeroDisplay } from '../display.svelte.js';

const SNAP_THRESHOLD = 0.3;
const OPEN_Y = -105;
const CLOSED_Y = 0;
export const FLIGHT_COOLDOWN_MS = 45_000;

function clamp(val: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, val));
}

export function useBlind(display: AeroDisplay) {
	let clipEl: HTMLDivElement | null = null;
	let lastFlightAtMs = 0;
	let isDragging = $state(false);
	let hasAnimated = $state(false);
	let dragY = $state(display.blindOpen ? OPEN_Y : CLOSED_Y);

	let containerHeight = 0;
	let dragStartY = 0;
	let dragStartPointerY = 0;

	const attach: Attachment<HTMLDivElement> = (node) => {
		clipEl = node;
		return () => {
			clipEl = null;
		};
	};

	// Keep dragY in sync with external model changes when not dragging.
	$effect(() => {
		if (!isDragging) {
			dragY = display.blindOpen ? OPEN_Y : CLOSED_Y;
		}
	});

	const transform = $derived(`translateY(${dragY.toFixed(1)}%)`);
	const transition = $derived(
		isDragging ? 'none' : 'transform 0.35s cubic-bezier(0.22, 0.68, 0, 1.05)'
	);

	function onPointerDown(e: PointerEvent) {
		hasAnimated = true;
		containerHeight = clipEl?.offsetHeight ?? 1;
		isDragging = true;
		dragStartY = dragY;
		dragStartPointerY = e.clientY;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}

	function onPointerMove(e: PointerEvent) {
		if (!isDragging) return;
		const deltaPct = ((e.clientY - dragStartPointerY) / containerHeight) * 100;
		dragY = clamp(dragStartY + deltaPct, OPEN_Y, CLOSED_Y);
	}

	function commitBlind(nextOpen: boolean): void {
		const wasOpen = display.config.blindOpen;
		display.config.blindOpen = nextOpen;

		// Pulling blind closed triggers a next-location exploration if past cooldown
		if (!wasOpen || nextOpen) return;
		const now = Date.now();
		if (now - lastFlightAtMs < FLIGHT_COOLDOWN_MS) return;
		lastFlightAtMs = now;
		// Not `?.()`. The method is always there, and an optional call on a name
		// that cannot be missing turns a future rename into silence.
		display.advanceLocation();
	}

	function onPointerUp() {
		if (!isDragging) return;
		isDragging = false;
		const travelRatio = Math.abs(dragY - dragStartY) / Math.abs(OPEN_Y);
		if (travelRatio > SNAP_THRESHOLD) {
			commitBlind(dragY < dragStartY);
		}
	}

	function onPointerCancel() {
		isDragging = false;
	}

	function onKeyDown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') commitBlind(!display.config.blindOpen);
	}

	return {
		attach,
		get transform() {
			return transform;
		},
		get transition() {
			return transition;
		},
		get hasAnimated() {
			return hasAnimated;
		},
		set hasAnimated(v: boolean) {
			hasAnimated = v;
		},
		get dragY() {
			return dragY;
		},
		onPointerDown,
		onPointerMove,
		onPointerUp,
		onPointerCancel,
		onKeyDown
	};
}
