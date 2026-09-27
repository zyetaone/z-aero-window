<script lang="ts">
	/**
	 * BootLockup — the held first frame.
	 *
	 * Identical artwork to the Plymouth boot theme and the X root window, so
	 * power-on through to a live window reads as ONE still frame that dissolves
	 * into motion, rather than three pictures in a row. If you restyle this,
	 * re-export deploy/pi/branding/aero-splash.png from the same markup or the
	 * handoff will visibly step.
	 *
	 * Branding: Zyeta product · SWA install · engine by rdtect
	 * (see `$lib/credits` — keep partners in sync with Plymouth/splash).
	 *
	 * Held until the scene is ready to show:
	 *   - flight: `measuredFps > 0` (first honest Cesium frame)
	 *   - video/slideshow: displayMode itself (globe is parked; no FPS)
	 */
	import { useAeroWindow } from '$lib/model/aero-window.svelte';
	import { DATA_CREDIT, ENGINEERED_BY, PRODUCT_PARTNERS, PRODUCT_SHORT } from '$lib/credits';

	const model = useAeroWindow();

	// Live once the active path is producing a view. Media modes stay live
	// without FPS because the globe render loop is intentionally paused.
	const isLive = $derived(
		model.displayMode !== 'flight' || model.measuredFps > 0,
	);

	// ─── COVERING AGAIN NEEDS A SUSTAINED STALL, NOT ONE ZERO SAMPLE ─────────
	// Re-covering on a genuine stall is right and stays. Re-covering on a
	// single zero-fps sample is what produced the reported "it starts, stops,
	// then starts again" cold boot.
	//
	// The Pi panel genuinely runs at 2-4 fps (see AeroWindow.measuredFps, which
	// exists precisely because a per-second counter has no resolution there).
	// At that rate one tile decode, one GC pause, or the first location hop is
	// enough for the median frame period to read as zero for a sample — and the
	// splash slammed back over a perfectly healthy scene, then lifted again.
	// Worst right after boot, when tile decoding is heaviest and the viewer is
	// most likely to be watching.
	//
	// So: lift on the first honest frame and require STALL_GRACE_MS of
	// continuous starvation before covering again. Same hysteresis reasoning as
	// nightPostFxOn in shaders.ts — an instantaneous test on a noisy signal
	// controlling an expensive, visible transition.
	const STALL_GRACE_MS = 5_000;
	let everLive = $state(false);
	let stalled = $state(false);
	$effect(() => {
		if (isLive) {
			everLive = true;
			stalled = false;
			return;
		}
		if (!everLive) return; // still the genuine first-boot hold
		const t = setTimeout(() => { stalled = true; }, STALL_GRACE_MS);
		return () => clearTimeout(t);
	});

	// What the view actually keys off: uncovered once we have seen a frame and
	// are not in a sustained stall.
	const uncovered = $derived(everLive && !stalled);

	// Safety: if Cesium never renders a frame (WebGL failure, stalled init),
	// dissolve after 15s. A half-rendered globe is better than a permanent
	// black screen. Logged to telemetry so operators can diagnose remotely.
	// forcedDissolve follows the same not-latched contract as isLive: a live
	// frame clears it, so a LATER genuine stall re-covers the view. While
	// latched, fps flapping must not re-arm the timer or re-log the error.
	let forcedDissolve = $state(false);
	$effect(() => {
		if (isLive) {
			forcedDissolve = false;
			return;
		}
		if (forcedDissolve) return; // already dissolved + reported
		const t = setTimeout(() => {
			forcedDissolve = true;
			model.telemetry.recordEvent('error', {
				where: 'boot-lockup',
				reason: 'timed-out-after-15s',
				fps: model.measuredFps,
			});
		}, 15_000);
		return () => clearTimeout(t);
	});
</script>

<div class={['boot-lockup', (uncovered || forcedDissolve) && 'dissolved']} aria-hidden={uncovered || forcedDissolve}>
	<div class="lockup">
		<div class="wordmark">
			<span class="word">Aero</span>
			<span class="word">Window</span>
		</div>
		<div class="rule-row">
			<span class="hair"></span>
			<span class="partners">
				<span class="partner">{PRODUCT_PARTNERS[0]}</span>
				<span class="cross">×</span>
				<span class="partner">{PRODUCT_PARTNERS[1]}</span>
			</span>
			<span class="hair right"></span>
		</div>
		<p class="engineered">{PRODUCT_SHORT} · engineered by {ENGINEERED_BY}</p>
		<p class="engineered data-credit">{DATA_CREDIT}</p>
	</div>
</div>

<style>
	.boot-lockup {
		position: fixed;
		inset: 0;
		z-index: 9999;
		display: grid;
		place-items: center;
		background: #000;
		/* The atmosphere the globe blooms into — already present under the
		   lockup, so the dissolve reveals depth rather than a flat cut. */
		background-image: radial-gradient(
			ellipse 120% 60% at 50% 118%,
			rgba(48, 76, 178, 0.3) 0%,
			transparent 62%
		);
		opacity: 1;
		transition: opacity 900ms ease;
		pointer-events: none;
	}

	.boot-lockup.dissolved {
		opacity: 0;
	}

	.lockup {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4.6vw;
		width: 62vw;
		text-align: center;
	}

	/* Two deliberate lines, not a wrap — the break is part of the mark, so it
	   stays put at any panel width instead of reflowing. */
	.wordmark {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.5vw;
	}

	.word {
		font-family: Ubuntu, 'Ubuntu Sans', system-ui, sans-serif;
		font-weight: 300;
		font-size: 6.2vw;
		white-space: nowrap;
		line-height: 1;
		letter-spacing: 0.34em;
		text-transform: uppercase;
		/* Optical centring — the trailing letter-space would otherwise push
		   the whole word left of true centre. */
		text-indent: 0.34em;
		color: var(--sw-silver, #cccccc);
	}

	.rule-row {
		display: flex;
		align-items: center;
		gap: 3.4vw;
		width: 100%;
	}

	.hair {
		flex: 1;
		height: 1px;
		background: linear-gradient(90deg, transparent, rgba(204, 204, 204, 0.42));
	}

	.hair.right {
		background: linear-gradient(270deg, transparent, rgba(204, 204, 204, 0.42));
	}

	.partners {
		display: flex;
		align-items: center;
		gap: 2.2vw;
		font-size: 1.85vw;
	}

	.partner {
		font-family: 'JetBrains Mono', ui-monospace, monospace;
		font-weight: 400;
		line-height: 1;
		letter-spacing: 0.3em;
		text-transform: uppercase;
		text-indent: 0.3em;
		color: #7e8496;
	}

	.cross {
		font-family: Ubuntu, 'Ubuntu Sans', system-ui, sans-serif;
		font-weight: 300;
		color: var(--sw-blue, #304cb2);
	}

	/* Quiet credit — must not fight the SWA partner line; fades under it. */
	.engineered {
		margin: 0;
		font-family: 'JetBrains Mono', ui-monospace, monospace;
		font-size: 1.05vw;
		font-weight: 400;
		letter-spacing: 0.18em;
		text-transform: uppercase;
		text-indent: 0.18em;
		color: rgba(126, 132, 150, 0.55);
	}

	@media (prefers-reduced-motion: reduce) {
		.boot-lockup {
			transition: none;
		}
	}
</style>
