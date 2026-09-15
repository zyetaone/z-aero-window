/**
 * tap — a single-tap / click gesture that coexists with the blind's
 * drag handling. Toggles the cabin clock.
 *
 * Ported from aero-1 `src/lib/shell/use-tap.ts`: same contract, same
 * tuning. A tap only fires when the pointer barely moved between down and
 * up (MOVE_TOLERANCE_PX), so pulling the blind never flashes the clock,
 * and long holds belong to the blind's gesture (MAX_PRESS_MS).
 *
 * aero-2 addition: `ignoreClosest`. This action attaches to the Display
 * root, which also hosts the settings drawer chrome — taps on buttons,
 * sliders and drawer panels must not toggle the clock. aero-1 did not
 * need this because its tap lived on the glass layer only.
 */

const MOVE_TOLERANCE_PX = 12;
const MAX_PRESS_MS = 500;

export interface TapOptions {
	/** Fired when a genuine tap completes (down+up, pointer barely moved). */
	onTap: () => void;
	/** Taps starting inside a match are not taps (drawer chrome, HUD buttons). */
	ignoreClosest?: string;
}

/**
 * Svelte action. Usage:
 *
 *     <div use:tap={{ onTap: () => (visible = !visible), ignoreClosest: 'aside,button' }}></div>
 */
export function tap(node: HTMLElement, options: TapOptions) {
	let opts = options;

	let downX = 0;
	let downY = 0;
	let downAt = 0;
	let down = false;
	let moved = false;

	const onPointerDown = (e: PointerEvent) => {
		// Only the primary pointer's main button starts a tap. A second finger
		// mid-press must not move the tap origin out from under the first
		// finger, and right-click is not a tap. (=== false / > 0 so synthetic
		// test events without these fields still count.)
		if (e.isPrimary === false || (e.button ?? 0) > 0) return;
		if (opts.ignoreClosest && (e.target as Element | null)?.closest?.(opts.ignoreClosest)) return;
		downX = e.clientX;
		downY = e.clientY;
		downAt = e.timeStamp;
		down = true;
		moved = false;
	};

	const onPointerMove = (e: PointerEvent) => {
		if (!down || moved) return;
		if (Math.hypot(e.clientX - downX, e.clientY - downY) > MOVE_TOLERANCE_PX) moved = true;
	};

	const onPointerUp = (e: PointerEvent) => {
		// Only a press that STARTED here counts — a drag that began outside
		// the container and happens to release over it is not a tap. Neither
		// is a long hold (that's the blind's gesture).
		if (down && !moved && e.timeStamp - downAt <= MAX_PRESS_MS) opts.onTap();
		down = false;
	};

	// `pointercancel` (scroll takeover, palm rejection) must not fire a tap.
	const onPointerCancel = () => {
		down = false;
		moved = false;
	};

	node.addEventListener('pointerdown', onPointerDown);
	node.addEventListener('pointermove', onPointerMove);
	node.addEventListener('pointerup', onPointerUp);
	node.addEventListener('pointercancel', onPointerCancel);

	return {
		update(next: TapOptions) {
			opts = next;
		},
		destroy() {
			node.removeEventListener('pointerdown', onPointerDown);
			node.removeEventListener('pointermove', onPointerMove);
			node.removeEventListener('pointerup', onPointerUp);
			node.removeEventListener('pointercancel', onPointerCancel);
		}
	};
}

/** Exported for tests — the tuning that defines "a tap". */
export const TAP_TUNING = {
	MOVE_TOLERANCE_PX,
	MAX_PRESS_MS
} as const;
