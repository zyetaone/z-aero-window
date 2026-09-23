// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { glassGestures } from '#lib/display/cabin/glass-gestures.js';

function pointer(type: string, x: number, y: number, t: number, target: Element) {
	const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }) as PointerEvent;
	Object.defineProperty(e, 'timeStamp', { value: t });
	Object.defineProperty(e, 'isPrimary', { value: true });
	target.dispatchEvent(e);
}

function mount() {
	const root = document.createElement('div');
	const chrome = document.createElement('button');
	root.appendChild(chrome);
	const onDoubleTap = vi.fn();
	const onLook = vi.fn();
	const detach = glassGestures({ onDoubleTap, onLook, ignoreClosest: 'button' })(root);
	return { root, chrome, onDoubleTap, onLook, detach };
}

describe('glassGestures', () => {
	it('two quick taps toggle the clock; one does not', () => {
		const { root, onDoubleTap } = mount();
		pointer('pointerdown', 100, 100, 1000, root);
		pointer('pointerup', 102, 101, 1100, root);
		expect(onDoubleTap).not.toHaveBeenCalled();
		pointer('pointerdown', 100, 100, 1250, root);
		pointer('pointerup', 100, 100, 1330, root);
		expect(onDoubleTap).toHaveBeenCalledTimes(1);
	});

	it('a drag looks around and is not a tap', () => {
		const { root, onDoubleTap, onLook } = mount();
		pointer('pointerdown', 100, 100, 1000, root);
		pointer('pointermove', 130, 100, 1050, root);
		pointer('pointermove', 160, 90, 1100, root);
		pointer('pointerup', 160, 90, 1150, root);
		pointer('pointerdown', 160, 90, 1200, root);
		pointer('pointerup', 160, 90, 1250, root);
		expect(onLook).toHaveBeenCalled();
		const [az, pitch] = onLook.mock.calls.at(-1)!;
		expect(az).toBeGreaterThan(0);
		expect(pitch).toBeGreaterThan(0);
		expect(onDoubleTap).not.toHaveBeenCalled();
	});

	it('ignores gestures that start on chrome', () => {
		const { chrome, onDoubleTap, onLook } = mount();
		pointer('pointerdown', 10, 10, 1000, chrome);
		pointer('pointermove', 60, 10, 1050, chrome);
		pointer('pointerup', 60, 10, 1100, chrome);
		pointer('pointerdown', 10, 10, 1150, chrome);
		pointer('pointerup', 10, 10, 1200, chrome);
		expect(onLook).not.toHaveBeenCalled();
		expect(onDoubleTap).not.toHaveBeenCalled();
	});
});
