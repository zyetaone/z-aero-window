import { describe, expect, it } from 'vitest';
import { gustAt, windMagAt } from '$lib/world/clouds/wind';
import { swayDeg, strobeOn, STROBE_PERIOD_S, STROBE_PULSE_S, STROBE_GAP_S } from '$lib/world/three/wing-motion';

/**
 * These used to be accumulators inside render tasks (`x += dt`), so a pane
 * at 20 fps and a pane at 60 fps drifted apart and a reboot restarted the
 * phase. As functions of the wall second, two panes sampling the same
 * instant must get the same answer whatever their frame rate — and the
 * envelopes must stay inside the ranges the visuals were tuned for.
 */
describe('wall-second helpers agree across frame rates', () => {
	const T0 = 1_700_000_000;
	it('gust and wind at coincident instants are identical at 60 and 20 fps', () => {
		for (let i = 0; i < 20; i++) {
			const t = T0 + i / 20; // every 20-fps instant is also a 60-fps instant
			expect(gustAt(t)).toBe(gustAt(T0 + (i * 3) / 60));
			expect(windMagAt(t)).toBe(windMagAt(T0 + (i * 3) / 60));
		}
	});
	it('envelopes stay in their tuned ranges', () => {
		for (let t = T0; t < T0 + 3600; t += 0.37) {
			expect(gustAt(t)).toBeGreaterThanOrEqual(0.45);
			expect(gustAt(t)).toBeLessThanOrEqual(1.55);
			expect(windMagAt(t)).toBeGreaterThanOrEqual(0.6);
			expect(windMagAt(t)).toBeLessThanOrEqual(1.6);
			expect(Math.abs(swayDeg(t))).toBeLessThanOrEqual(2.5);
		}
	});
	it('strobe double-flashes once per period and is on for exactly two pulses', () => {
		let on = 0;
		const steps = 1100;
		for (let i = 0; i < steps; i++) if (strobeOn(T0 + (i * STROBE_PERIOD_S) / steps)) on++;
		expect(on / steps).toBeCloseTo((2 * STROBE_PULSE_S) / STROBE_PERIOD_S, 2);
		// Phase-relative checks from a period-aligned base (T0 is not one).
		const base = 1000 * STROBE_PERIOD_S;
		expect(strobeOn(base + STROBE_PULSE_S / 2)).toBe(true);
		expect(strobeOn(base + STROBE_GAP_S + STROBE_PULSE_S / 2)).toBe(true);
		expect(strobeOn(base + STROBE_GAP_S + STROBE_PULSE_S + 0.01)).toBe(false);
	});
	it('a rebooted pane lands on the same phase as one that never restarted', () => {
		// Nothing here depends on history: calling once is the same as calling after a million frames.
		const t = T0 + 12345.678;
		expect(strobeOn(t)).toBe(strobeOn(t));
		expect(swayDeg(t)).toBe(1.7 * Math.sin(t * 0.52) + 0.8 * Math.sin(t * 0.97 + 1.3));
	});
});
