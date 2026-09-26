/**
 * The quality governor: shed GPU work when THIS Pi cannot keep up, restore
 * exactly what was taken, never touch the wall.
 *
 * Two triggers, one piece of state. Extracted from Display.svelte because it
 * is the one concern there with its own reason to change (thresholds, a third
 * trigger, telemetry) that has nothing to do with mounting layers. Call once
 * from the component that owns the display; both effects are lifecycle and
 * clean up with it.
 */
import { untrack } from 'svelte';
import type { AeroDisplay } from './display.svelte.js';
import { createThermalPoller } from '#lib/settings/thermal-poll.js';
import type { ThermalAction } from '#lib/throttle.js';

export function installQualityGovernor(display: AeroDisplay): void {
	/**
	 * Shed GPU work when this Pi is actually throttling.
	 *
	 * LOCAL, never the wall: one hot edge pane must not dim the other two, which
	 * is why `/api/internal/thermal` is loopback-only. It drives `qualityMode`,
	 * the knob the render path already reads, rather than adding a second
	 * quality concept beside it.
	 *
	 * The operator's own choice wins. If someone has explicitly asked for
	 * `ultra` or `performance` this leaves it alone: shedding is for the default
	 * `balanced` case, where nobody has expressed a preference and the device is
	 * telling us it cannot keep up. Restoring puts back exactly what was taken,
	 * so a thermal event cannot permanently downgrade a pane.
	 *
	 * THE STATE LIVES OUTSIDE THE EFFECT, and that is the whole design.
	 *
	 * The first version kept `shedFrom` in a closure created inside the effect,
	 * and the effect both wrote `qualityMode` and — through the poller's `get
	 * action()` — read it. So the write invalidated the effect that made it, the
	 * effect re-ran, the closure was rebuilt with `shedFrom` back to null, and
	 * the new poller's immediate first poll shed again. On a device held at a
	 * constant 88 C that oscillated: shed, restore, shed, once per cycle,
	 * flipping the render quality of a kiosk that nobody is looking at.
	 * `untrack` around the CONSTRUCTOR did not fix it, because the callbacks run
	 * later and re-enter the effect's scope on every poll.
	 *
	 * Hoisting the state out makes the effect own one thing — the poller's
	 * lifetime — and gives the sink somewhere to remember across re-runs, which
	 * is what "only report on change" needs to mean anything.
	 *
	 * A plain `let`, NOT `$state`, for the same reason `hasAdvanced` on
	 * AeroDisplay is plain: nothing renders it, and the effect reads it through
	 * `get action()` — so making it reactive would mean every write re-ran the
	 * effect that made it, tearing down the poller and rebuilding one whose
	 * immediate first poll sheds again. That is the oscillation above, reached
	 * by a second route.
	 */
	let shedFrom: 'ultra' | 'balanced' | 'performance' | null = null;

	const thermalSink = {
		get action(): ThermalAction {
			return shedFrom === null ? 'ok' : 'shed';
		},
		setAction(next: ThermalAction) {
			untrack(() => {
				if (next === 'shed') {
					if (shedFrom !== null || display.config.qualityMode !== 'balanced') return;
					shedFrom = display.config.qualityMode;
					display.config.qualityMode = 'performance';
					console.warn('[thermal] throttling — dropped to performance quality');
					return;
				}
				if (shedFrom === null) return;
				// Only restore what we took. An operator who changed it meanwhile owns it.
				if (display.config.qualityMode === 'performance') display.config.qualityMode = shedFrom;
				shedFrom = null;
				console.info('[thermal] recovered — quality restored');
			});
		}
	};

	$effect(() => {
		const poller = createThermalPoller(thermalSink);
		return () => poller.stop();
	});

	/**
	 * Shed on sustained low FPS too, not only on a thermal signal.
	 *
	 * The thermal path above reads `/api/internal/thermal`, which reads
	 * `vcgencmd`. That is a Pi telling us it is HOT. A device can be perfectly
	 * cool and still too slow — a weaker GPU, a 4K panel, a driver falling back
	 * to software — and the thermal poller never fires, so nothing sheds and the
	 * wall runs at 6 fps indefinitely.
	 *
	 * v1 hit exactly this and wrote `lifecycle-overlay-recovery.ts` for it,
	 * whose docstring is worth quoting because it names the gap precisely: "The
	 * liveness watchdog only catches fps == 0 (stall/death). A Pi 5 that can
	 * handle Cesium at ~8 fps but drops to ~3 fps with the Three overlay is
	 * never 'dead' — just silently degraded." The rewrite inherited the stall
	 * watchdog and the thermal shed, and neither covers slow-but-alive.
	 *
	 * SUSTAINED, so a tile burst or a GC pause cannot trigger it: five
	 * consecutive one-second samples under the threshold, which is the same
	 * shape as v1's three 30-second checks scaled to the sampler that already
	 * exists here. 20 fps because the window is a moving image — below that the
	 * flight reads as a slideshow, and `performance` mode halves the cloud deck,
	 * which is the single biggest GPU cost.
	 *
	 * Shares `shedFrom` with the thermal path deliberately. Two independent shed
	 * mechanisms writing one knob is how you get the oscillation the comment
	 * above describes; one piece of state means whichever fires first owns the
	 * restore, and the other sees `shedFrom !== null` and leaves it alone.
	 */
	const FPS_SHED_THRESHOLD = 20;
	const FPS_SHED_SAMPLES = 5;
	let lowFpsRun = 0;

	$effect(() => {
		const id = setInterval(() => {
			untrack(() => {
				// Not before the loop has started: `fps` holds its constructor
				// default of 60 until the first sample, and a pre-boot reading is
				// not evidence of anything.
				if (!display.hasAdvanced) return;

				if (display.fps >= FPS_SHED_THRESHOLD) {
					lowFpsRun = 0;
					return;
				}
				if (++lowFpsRun < FPS_SHED_SAMPLES) return;

				// Same guards as the thermal path: only shed from the default, and
				// never twice.
				if (shedFrom !== null || display.config.qualityMode !== 'balanced') return;
				shedFrom = display.config.qualityMode;
				display.config.qualityMode = 'performance';
				console.warn(
					`[perf] ${display.fps} fps for ${FPS_SHED_SAMPLES}s — dropped to performance quality`
				);
			});
		}, 1000);
		return () => clearInterval(id);
	});
}
