<script lang="ts">
	/**
	 * Display — Top-level parent feature component for the kiosk window display.
	 * Composes the outside 3D world (Stage), aircraft wing silhouette (Wing),
	 * inside cabin chrome (Frame), minimap (MiniMap), and telemetry status band (Hud).
	 *
	 * Uses Svelte 5 <svelte:boundary> to isolate 3D WebGL runtime errors from taking
	 * down the cabin frame or operator UI.
	 */
	// './world/Stage.svelte', NOT './world/maplibre/Stage.svelte'. The latter
	// exists only in another session's uncommitted working tree, and an earlier
	// commit here picked the line up mid-edit -- so main pointed at a directory
	// git has never seen and a clean clone could not build.
	import Stage from './world/Stage.svelte';
	import Clouds from './world/Clouds.svelte';
	import Wing from './cabin/Wing.svelte';
	import Grade from './cabin/Grade.svelte';
	import Frame from './cabin/Frame.svelte';
	import Blind from './cabin/Blind.svelte';
	import AdminQr from './cabin/AdminQr.svelte';
	import RainGlass from './cabin/RainGlass.svelte';
	import Hud from './cabin/Hud.svelte';
	import MiniMap from './flight/MiniMap.svelte';
	import GlassClock from './cabin/GlassClock.svelte';
	import { glassGestures } from './cabin/glass-gestures.js';
	import MediaStage from './media/MediaStage.svelte';
	import AudioHost from './media/AudioHost.svelte';
	import { useDisplay } from './display.svelte.js';
	import { untrack } from 'svelte';
	import type { Snippet } from 'svelte';
	import { createWallPoller } from '#lib/settings/wall-poll.js';
	import { tryConsumeReloadBudget } from './reload-budget.js';
	import { installQualityGovernor } from './quality-governor.svelte.js';
	import { PUBLIC_WALL_ORIGIN } from '$app/env/public';

	/**
	 * `hud` is the only switch here, because it is the only one with a caller.
	 *
	 * There used to be five -- clouds, wing, minimap, blind -- and +page.svelte
	 * passed exactly one of them. Three of the other four duplicated a config
	 * knob the child already reads (`Clouds` gates on `config.clouds`, `Wing` on
	 * `config.wing`, `Blind` on `config.blindOpen`), so the same light had two
	 * switches and only one of them was wired to anything.
	 */
	interface Props {
		hud?: boolean;
		children?: Snippet;
	}

	let { hud = true, children }: Props = $props();

	const display = useDisplay();

	/** Double-tap on the glass shows the wall clock; mounted only while shown. */
	let clockVisible = $state(false);
	const gestures = glassGestures({
		onDoubleTap: () => (clockVisible = !clockVisible),
		onLook: (az, pitch) => {
			display.config.nudge('azimuthDeg', az);
			display.config.nudge('pitchDeg', pitch);
		},
		ignoreClosest: 'aside, nav, button, .blind-clip, .blind-grab, .blind-slats, .qr-backdrop, .look-controls, .minimap'
	});
	// DEV harness handle (the branch's headless capture scripts poke knobs through it).
	if (import.meta.env.DEV) (globalThis as unknown as { __display?: unknown }).__display = display;

	/**
	 * Night grade on the world, before the cabin chrome is drawn over it.
	 *
	 * Continuous in `display.night` (ADR-007: a function of the wall clock, so
	 * three panes agree and dusk ramps instead of popping). At full night it is
	 * contrast 1.3 / saturate 0.85 / brightness 0.9, which took the 6 km Dubai
	 * frame from a flat grey-green wash to amber filaments on a near-black void
	 * in the Sep-22 A/B against the Feb-18 Cesium reference. A compositor colour
	 * matrix, not a render pass: no measurable frame cost on the Mac, Pi unmeasured.
	 * Rounded to 0.01 so the style attribute is not rewritten every frame.
	 */
	const nightGrade = $derived.by(() => {
		const n = Math.round(display.night * 100) / 100;
		if (n <= 0) return 'none';
		return `contrast(${1 + 0.3 * n}) saturate(${1 - 0.15 * n}) brightness(${1 - 0.1 * n})`;
	});

	function onStageError(error: unknown) {
		console.error('[AeroDisplay] 3D World Stage error caught by boundary:', error);
	}

	/**
	 * The watchdog: a frozen window looks exactly like a working one.
	 *
	 * `<svelte:boundary>` catches a THROW. It cannot see a stall — a render loop
	 * that stops being called leaves a live canvas holding its last frame, at a
	 * plausible altitude, with a clean console. On a wall in Hyderabad that is a
	 * photograph of an aeroplane window, indistinguishable from the product.
	 *
	 * TWO failures, not one, and the first version of this only caught the
	 * second. A loop that never STARTS looks identical to one that stops: the
	 * pose is whatever the constructor computed, the HUD reads the constructor's
	 * 60 FPS / 16.6 ms defaults, four canvases are mounted, nothing throws. That
	 * state was reproduced here on a clean load — two readings six seconds apart,
	 * byte-identical — and the watchdog called it healthy, because it only
	 * measured elapsed time once a first frame had arrived.
	 *
	 * `view.wallSec` is the timestamp of the last pose the loop derived, so the
	 * gap between it and the real clock IS the stall. Before the first frame
	 * there is no such gap to measure, so the clock starts at mount instead.
	 */
	const STALL_SEC = 12;
	/** A loop that has not drawn once by here is not slow, it is broken. */
	const BOOT_SEC = 30;
	/** Long enough that a slow tile load or a GC pause cannot trigger a reload. */
	const RELOAD_SEC = 60;

	const mountedAtSec = Date.now() / 1000;

	/**
	 * The one legitimate second clock in the display.
	 *
	 * Three private clocks were deleted from this codebase for splitting the
	 * fleet, so this needs saying: a watchdog sharing the frame loop's clock
	 * could not detect the frame loop stopping. Independence is the mechanism,
	 * not an oversight — and it is pane-local by nature, observing this process
	 * rather than deriving anything three panes must agree on.
	 */
	// `$state.raw` — replaced wholesale once a second, never mutated. Same
	// rationale as `AeroDisplay.view`, at 1/60th the rate; consistency is the
	// point more than the microseconds.
	let probe = $state.raw({ started: false, lastFrameSec: 0, nowSec: mountedAtSec });

	$effect(() => {
		const id = setInterval(() => {
			probe = {
				started: display.hasAdvanced,
				lastFrameSec: display.view.wallSec,
				nowSec: Date.now() / 1000
			};
		}, 1000);
		return () => clearInterval(id);
	});

	/** Seconds of stillness — since the last frame, or since mount if there was none. */
	const frozenSec = $derived(
		Math.max(0, probe.nowSec - (probe.started ? probe.lastFrameSec : mountedAtSec))
	);
	const stalled = $derived(frozenSec > (probe.started ? STALL_SEC : BOOT_SEC));

	/**
	 * Unattended recovery, because nobody is looking at this screen.
	 *
	 * There is no fleet layer yet: no heartbeat, no operator alert, no console
	 * anyone reads, so detection alone would change nothing on the wall. A
	 * reload is crude and that is the point — if it reloads and stalls again it
	 * keeps reloading, up to the hourly cap, which is at least visibly broken
	 * rather than invisibly frozen. Past the cap it stops and stays frozen: a
	 * wall strobing white every minute is a worse failure than a still one, and
	 * the nightly reboot is the honest escalation.
	 *
	 * Production only. `vite dev` serves maplibre unbundled, so a cold start can
	 * legitimately take longer than BOOT_SEC, and a development machine that
	 * reloads itself every minute is not a development machine. The banner still
	 * shows in dev — the diagnosis is useful there, the reboot is not.
	 *
	 * BUDGETED, because a reload only helps a TRANSIENT fault and the two are
	 * indistinguishable here. A Pi whose GPU cannot initialise at all comes back
	 * from the reload into exactly this state, so uncapped it strobes the wall
	 * white every sixty seconds until someone drives to the site. Three per hour,
	 * then leave it frozen for the nightly reboot — v1's rule, which the rewrite
	 * inherited the watchdog from and not the cap.
	 */
	$effect(() => {
		if (!stalled || frozenSec <= RELOAD_SEC || !import.meta.env.PROD) return;
		if (tryConsumeReloadBudget()) location.reload();
	});

	/**
	 * Poll the shared wall state.
	 *
	 * Here rather than in Stage, because the buffer belongs to the display and
	 * outlives any one renderer — Stage remounts on a WebGL context loss and a
	 * poll that remounted with it would drop the pending snapshot.
	 *
	 * It only fills `display.wall`; `advanceTo` is what applies it, at the second
	 * the snapshot names. An empty PUBLIC_WALL_ORIGIN means this pane polls
	 * itself, which is the correct single-pane behaviour.
	 */
	$effect(() => {
		const poller = createWallPoller(display.wall, PUBLIC_WALL_ORIGIN);
		// First poll now rather than one interval from now: a pane that just booted
		// should pick up a wall that was set before it did.
		void poller.poll();
		return () => poller.stop();
	});

	installQualityGovernor(display);

	/**
	 * Tell this device's own server what frame rate the tab is seeing.
	 *
	 * The measurement lives in the render loop, in the browser. Everything that
	 * wants it lives outside: `health-check.sh` scrapes `GET /api/status` every
	 * 60 s and POSTs to the admin, which averages it across the wall. Without
	 * this one fetch that entire chain reports nothing — and it did.
	 * `HeartbeatSample.fps` is declared, parsed, averaged and rendered, and the
	 * cockpit showed an em-dash for every device, permanently, because nothing
	 * ever produced the number. Built end to end except for the wire.
	 *
	 * Every 5 s against a 30 s staleness window, so a pane has six chances to be
	 * counted before its reading is dropped, and a tab that dies stops being
	 * reported rather than freezing at its last healthy value.
	 *
	 * Fire-and-forget, and errors are swallowed on purpose: this is an
	 * instrument, and an instrument that can break the thing it measures is
	 * worse than no instrument. Same reason it does not run in dev — a
	 * development machine reporting fps to itself is noise.
	 */
	$effect(() => {
		if (!import.meta.env.PROD) return;
		const id = setInterval(() => {
			const body = untrack(() =>
				JSON.stringify({ fps: display.fps, frameTimeMs: display.frameTimeMs })
			);
			void fetch('/api/internal/vitals', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
				keepalive: true
			}).catch(() => {
				/* An unreachable local server is its own symptom; do not add a second. */
			});
		}, 5000);
		return () => clearInterval(id);
	});
</script>

<div class="aero-display" {@attach gestures}>
	<!-- 3D World protected by Svelte 5 Error Boundary -->
	<svelte:boundary onerror={onStageError}>
		<!-- Sized explicitly: a non-none filter makes this the containing block for
		     Stage's absolutely positioned canvas, so an unsized wrapper would collapse
		     it to zero height the moment night begins. -->
		<div class="world-graded" style:filter={nightGrade}>
			<Stage />
		</div>

		<!-- Inside the boundary, like the rest of the 3D world: Clouds runs its
		     own WebGL context and can lose it exactly the way Stage can. It sat
		     outside, so a Three.js context loss took down the whole page while
		     the identical failure in MapLibre was caught and offered a retry. -->
		<Clouds />

		{#if stalled}
			<div class="stage-error-fallback">
				<div class="glass-panel error-card">
					<h3>Display Signal Lost</h3>
					<p>
						{probe.started
							? `The window stopped drawing ${Math.round(frozenSec)}s ago.`
							: `The window has not drawn a frame in ${Math.round(frozenSec)}s.`}
					</p>
					<button type="button" class="glass-btn" onclick={() => location.reload()}>
						Reload
					</button>
				</div>
			</div>
		{/if}

		{#snippet failed(error, reset)}
			<div class="stage-error-fallback">
				<div class="glass-panel error-card">
					<h3>Display Signal Lost</h3>
					<p>{error instanceof Error ? error.message : 'WebGL rendering error'}</p>
					<button type="button" class="glass-btn" onclick={reset}>Re-initialize Stage</button>
				</div>
			</div>
		{/snippet}
	</svelte:boundary>

	<!-- Grade first: the world gets finished, the cabin chrome does not. -->
	<Grade />
	<Wing />
	<RainGlass />
	<Frame />
	<Blind />
	{#if display.config.miniMapVisible}
		<MiniMap />
	{/if}
	{#if clockVisible}
		<GlassClock />
	{/if}
	<!-- `visible`, not `{#if}`: Hud owns the `--hud-height` CSS variable the
	     rest of the cabin lays out against, and unmounting it left that variable
	     stale at the ribbon height with no ribbon under it. -->
	<Hud visible={hud} />
	<!-- MediaStage mounts only off-flight: its own template already renders
	     nothing in `flight`, but the instance keeps a wallSec-tracking slide
	     index and playlist deriveds alive. AudioHost deliberately stays
	     mounted in every mode — the synth rumble is a flight-mode feature
	     (altitude-modulated), and its engine calls early-return without a
	     context, so its idle cost is two no-op calls per frame. -->
	{#if display.config.displayMode !== 'flight'}
		<MediaStage />
	{/if}
	<AudioHost />
	<!-- Last, so its overlay sits above the cabin chrome when it opens. The
	     hotspot itself is an invisible corner and takes no space until held. -->
	<AdminQr />
	{@render children?.()}
</div>

<style>
	.aero-display {
		position: fixed;
		inset: 0;
		background: #000;
		overflow: hidden;
		user-select: none;
	}
	.world-graded {
		position: absolute;
		inset: 0;
	}
	.stage-error-fallback {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		background: #05080e;
		z-index: 1;
	}
	.error-card {
		padding: 24px;
		text-align: center;
		max-width: 360px;
	}
	.error-card h3 {
		margin: 0 0 8px 0;
		color: #f87171;
	}
	.error-card p {
		font-size: 0.85rem;
		color: var(--text-muted);
		margin-bottom: 16px;
	}
</style>
