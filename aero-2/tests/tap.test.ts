import { describe, it, expect } from 'vitest';
import { tap, TAP_TUNING } from '#lib/display/cabin/tap.js';

// happy-dom leaves `isPrimary` at its spec default (false); real browsers
// deliver `true` for the primary pointer, which is what the action gates on.
function pointer(target: HTMLElement, type: string, init: PointerEventInit = {}) {
	target.dispatchEvent(
		new PointerEvent(type, { bubbles: true, clientX: 0, clientY: 0, isPrimary: true, ...init })
	);
}

describe('tap action', () => {
	it('fires on a clean down+up', () => {
		const node = document.createElement('div');
		let fired = 0;
		const action = tap(node, {
			onTap: () => {
				fired += 1;
			}
		});
		pointer(node, 'pointerdown');
		pointer(node, 'pointerup');
		expect(fired).toBe(1);
		action.destroy();
	});

	it('ignores drags past the move tolerance (blind pulls never clock)', () => {
		const node = document.createElement('div');
		let fired = 0;
		const action = tap(node, {
			onTap: () => {
				fired += 1;
			}
		});
		pointer(node, 'pointerdown', { clientX: 0, clientY: 0 });
		pointer(node, 'pointermove', { clientX: 0, clientY: TAP_TUNING.MOVE_TOLERANCE_PX + 1 });
		pointer(node, 'pointerup', { clientX: 0, clientY: TAP_TUNING.MOVE_TOLERANCE_PX + 1 });
		expect(fired).toBe(0);
		action.destroy();
	});

	it('ignores holds past the press budget (blind long-press never clocks)', () => {
		const node = document.createElement('div');
		let fired = 0;
		const action = tap(node, {
			onTap: () => {
				fired += 1;
			}
		});
		// e.timeStamp is when the event was created; redefine it to emulate
		// a press held past the tap budget.
		const t0 = 1000;
		const down = new PointerEvent('pointerdown', { bubbles: true });
		Object.defineProperty(down, 'timeStamp', { value: t0 });
		const up = new PointerEvent('pointerup', { bubbles: true });
		Object.defineProperty(up, 'timeStamp', { value: t0 + TAP_TUNING.MAX_PRESS_MS + 1 });
		node.dispatchEvent(down);
		node.dispatchEvent(up);
		expect(fired).toBe(0);
		action.destroy();
	});

	it('ignores taps starting in drawer chrome', () => {
		const node = document.createElement('div');
		node.innerHTML = '<aside><button>close</button></aside>';
		const button = node.querySelector('button')!;
		let fired = 0;
		const action = tap(node, {
			onTap: () => {
				fired += 1;
			},
			ignoreClosest: 'aside,button'
		});
		pointer(button, 'pointerdown');
		pointer(button, 'pointerup');
		expect(fired).toBe(0);
		action.destroy();
	});
});
