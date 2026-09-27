<script lang="ts">
	import { untrack } from 'svelte';
	/**
	 * Aero Dynamic Window - Main Page
	 *
	 * Circadian-aware airplane window display with:
	 * - Real terrain and buildings (Cesium)
	 * - CSS effect layers (clouds, weather, city lights)
	 * - Time-synced sky states
	 * - Cabin interior context
	 */

	import { onDestroy, onMount } from "svelte";
	import { createAeroWindow } from "$lib/model/aero-window.svelte";
	import { isValidLocation } from "$content/locations";
	import { isValidWeather } from "$lib/types";
	import { savePersistedState } from "$lib/model/persistence";
	import { clearOverlayDisabled } from "$lib/world/lifecycle-overlay-recovery";
	import { createDeviceClient } from "$lib/fleet/client.svelte";
	import { resolveBinding, isGroupLeader } from "$lib/fleet/parallax.svelte";
	import { startThermalGuard } from "$lib/fleet/thermal-guard.svelte";
	import BootLockup from "$lib/shell/BootLockup.svelte";
	import Pane from "$lib/shell/pane/Pane.svelte";
	import Controls from "$lib/shell/passenger/HUD.svelte";
	import SidePanel from "$lib/shell/operator/SidePanel.svelte";
	import TelemetryPanel from "$lib/shell/operator/TelemetryPanel.svelte";
	// Composed panel sections — page picks the set + order it wants.
	import LocationPicker from "$lib/shell/operator/panel/LocationPicker.svelte";
	import TimeControl from "$lib/shell/operator/panel/TimeControl.svelte";
	import FlightControls from "$lib/shell/operator/panel/FlightControls.svelte";
	import AtmosphereControls from "$lib/shell/operator/panel/AtmosphereControls.svelte";
	import AudioControls from "$lib/shell/operator/panel/AudioControls.svelte";
	import AmbientAudioHost from "$lib/shell/audio/AmbientAudioHost.svelte";
	import LightingControls from "$lib/shell/operator/panel/LightingControls.svelte";
	import WeatherPicker from "$lib/shell/operator/panel/WeatherPicker.svelte";
	// Lab panels: DEV-only dynamic import so production client graph never
	// links NightVariantPanel / LabControls (large harness + duplicated GLSL).

	// Create unified app state (provides context to all child components)
	// All state is reactive via $state/$derived in AeroWindow
	const model = createAeroWindow();

	// Lab mode (?lab=1, DEV only) — see the param parsing in onMount.
	// The renderer selector in LabControls owns the useThreeOverlay write on
	// mode change (user interaction); labRenderer only mirrors the selection
	// here for the NightVariantPanel mount gate below.
	let labMode = $state(false);
	let labRenderer = $state<'cesium' | 'hybrid' | 'night-lab'>('cesium');

	$effect(() => {
		if (model.syncToRealTime && typeof window !== "undefined") {
			const update = () => model.updateTimeFromSystem();
			const interval = setInterval(
				update,
				model.config.director.daylight.syncIntervalMs,
			);
			return () => clearInterval(interval);
		}
		return undefined;
	});

	// Debounced auto-save (moved out of AeroWindow for testability).
	// `getPersistedSnapshot()` reads `flight.altitude`, which the cruise
	// engine writes on EVERY tick. Without a structural-change guard the
	// $effect re-ran 60×/sec, scheduling + cancelling a setTimeout each
	// frame (no leak, but constant microtask + GC churn). Hash the
	// snapshot and skip when nothing meaningful changed.
	// The hash is a $derived string, so the effect below only re-runs when
	// the VALUE changes — not on every altitude tick that leaves it equal.
	// Round altitude to 100 ft — sub-100 ft cruise jitter shouldn't
	// trigger a re-save. Other fields are categorical/booleans. Ambient
	// MUST be in the hash: a pure ambient admin push (haze, qualityMode…)
	// changes no other field, and an unchanged hash would skip the save —
	// the whole point of PersistedState.ambient. Key order is stable
	// (AMBIENT_PERSIST_PATHS iteration order), so stringify is safe.
	const snapHash = $derived.by(() => {
		const d = model.getPersistedSnapshot();
		return `${Math.round(d.altitude / 100)}|${d.cloudDensity}|${d.buildingsEnabled}|${d.showClouds}|${JSON.stringify(d.ambient)}`;
	});
	$effect(() => {
		void snapHash;
		const timeout = setTimeout(() => savePersistedState(untrack(() => model.getPersistedSnapshot())), 2000);
		return () => clearTimeout(timeout);
	});

	// Fleet connection — SSE subscriber to own server's /api/events + peer
	// broadcast fan-out for Phase 7 leader→follower director_decision.
	// Always connects so the Pi is discoverable and responsive to admin
	// PATCHes even if Cesium/WebGL fails downstream.
	// onMount, not $effect: no reactive deps, runs once per page lifecycle.
	onMount(() => {
		const client = createDeviceClient(model);
		// Phase 7 — register the leader-broadcast hook so the director can
		// emit director_decision messages when this device is a panorama
		// leader. Solo devices set the hook too, but the model only emits
		// when role is 'center' — solo never broadcasts and flies immediately.
		model.setFleetBroadcast((msg) => client.publishV2(msg));
		// Pi thermal / power throttle → local GPU load-shed (see thermal-guard).
		const stopThermal = startThermalGuard(model);
		return () => {
			stopThermal();
			model.setFleetBroadcast(null);
			client.destroy();
		};
	});

	
	// Clean up model timers on page teardown
	onDestroy(() => model.destroy());

	// Keyboard ops (svelte:window onkeydown below). Skip when typing in inputs.
	// Escape — exit video/slideshow to flight on ANY pane (edge panes hide
	// SidePanel; this is their local recovery without ?ops=1 / admin).
	// F — window frame toggle (designer spec Phase 5b); flight-only chrome.
	function handleKey(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
		if (e.key === "Escape" && model.displayMode !== "flight") {
			e.preventDefault();
			model.setDisplayMode("flight");
			return;
		}
		if (e.key !== "f" && e.key !== "F") return;
		if (model.displayMode !== "flight") return; // frame forced off during media
		model.applyConfigPatch('shell.windowFrame', !model.config.shell.windowFrame);
	}

	// Global error capture (production hardening) — uncaught throws and
	// unhandled rejections land in the telemetry ring, which the fleet
	// heartbeat summarises to /api/status → visible on the admin health page
	// WITHOUT SSH. Audience never sees anything (council: never break the
	// fiction). Wired via <svelte:window> below per Svelte 5 best practices.
	function handleGlobalError(e: Event) {
		// svelte:window types onerror generically; the global error event IS
		// an ErrorEvent — narrow to read message/filename (resource-load
		// errors arrive as plain Events; still worth counting).
		const ee = e instanceof ErrorEvent ? e : null;
		model.telemetry.recordEvent("error", {
			where: "window.onerror",
			message: String(ee?.message ?? "resource error").slice(0, 200),
			source: ee ? `${ee.filename ?? ""}:${ee.lineno ?? 0}` : "",
		});
	}
	function handleUnhandledRejection(e: PromiseRejectionEvent) {
		const r = e.reason;
		model.telemetry.recordEvent("error", {
			where: "unhandledrejection",
			message: (r instanceof Error ? r.message : String(r)).slice(0, 200),
		});
	}

	// Apply per-device config from URL search params (?location=dubai&altitude=30000)
	if (typeof window !== "undefined") {
		const params = new URLSearchParams(window.location.search);

		const locationParam = params.get("location")?.toLowerCase();
		if (isValidLocation(locationParam)) {
			model.setLocation(locationParam);
		}

		// setAltitude clamps to camera.altitude.min/max downstream — the old
		// range check here silently DROPPED out-of-range values instead
		// (?altitude=3000 was ignored, min is 10000), which reads as "param
		// broken" during perf/visual A/Bs. Clamp-at-bound is the slider's
		// semantics; match it.
		const altitudeParam = params.get("altitude");
		if (altitudeParam) {
			const alt = Number(altitudeParam);
			if (Number.isFinite(alt)) model.setAltitude(alt);
		}

		// Pin time-of-day via ?time=2 (decimal hours 0-24) for a reproducible
		// scenario — disables real-time sync so the wall-clock can't override it.
		// Pairs with ?overlay for a fixed "Hyderabad night" A/B (perf gate + visual
		// comparison) instead of whatever hour it happens to be at the kiosk.
		const timeParam = params.get("time");
		if (timeParam !== null && timeParam !== "") {
			const t = Number(timeParam);
			if (Number.isFinite(t) && t >= 0 && t <= 24) {
				model.syncToRealTime = false;
				model.setTime(t);
			}
		}

		// Pin weather via ?weather=clear — completes the reproducible-scenario
		// trio with ?time + ?overlay so the perf/visual A/B isn't at the mercy
		// of whatever the director randomised at boot.
		const weatherParam = params.get("weather")?.toLowerCase();
		if (isValidWeather(weatherParam)) {
			model.setWeather(weatherParam);
		}

		// A pinned scene (?location / ?time / ?weather) is a reproducible A/B —
		// park the director so its location cycler can't fly away from the
		// pinned scenario mid-measurement (the P8 perf gate depends on this).
		if (isValidLocation(locationParam) || timeParam || isValidWeather(weatherParam)) {
			model.applyConfigPatch('director.autopilot.enabled', false);
		}

		// Perf-gate A/B (P8): force the hybrid Three overlay ON/OFF on the SHIP
		// route via ?overlay=1 / ?overlay=0, so the Pi-5 benchmark can measure the
		// exact shipping tree BOTH ways from one URL each (the go/no-go is the
		// delta). No param leaves the config-tree default (now true) untouched.
		// ?overlay=0 is therefore the per-Pi escape hatch on a device that can't
		// hold framerate — it does NOT persist across reboot (not in PersistedState),
		// so a struggling Pi needs it baked into the kiosk unit's URL.
		const overlayParam = params.get("overlay");
		if (overlayParam === "1" || overlayParam === "true") {
			model.applyConfigPatch('world.useThreeOverlay', true);
			// Explicit re-enable: lift any persisted low-fps auto-disable so the
			// next boot (and GlobeLayer's boot-time check) honours the override.
			clearOverlayDisabled();
		} else if (overlayParam === "0" || overlayParam === "false") {
			model.applyConfigPatch('world.useThreeOverlay', false);
		}

		// Phase 7 — multi-Pi parallax. resolveBinding() is the SSOT (URL →
		// fingerprint map → self-binding → legacy role key → solo). Mirror
		// into camera.parallax.role so FOV/yaw offsets and isGroupLeader()
		// agree with fleet groupId filtering. Do NOT re-read a second
		// localStorage key here — that dual path used to let role and
		// groupId diverge across reloads.
		const binding = resolveBinding();
		model.applyConfigPatch('camera.parallax.role', binding.role);
		// Non-solo roles auto-hide the window frame: three oval frames tile poorly.
		if (binding.role !== 'solo') {
			model.applyConfigPatch('shell.windowFrame', false);
		}


		// Hash palette A/B: ?hashpalette=0 disables the production night look
		// to compare against aero-color-grade. ?hashpalette=1 re-enables it.
		const hpParam = params.get('hashpalette');
		if (hpParam === '1' || hpParam === 'true') {
			model.applyConfigPatch('world.useHashPalette', true);
		} else if (hpParam === '0' || hpParam === 'false') {
			model.applyConfigPatch('world.useHashPalette', false);
		}

		// Lab mode: ?lab=1 replaces the deleted /playground routes. The renderer
		// selector, wing tuner and night-variant harness now live in the ship
		// route's own SidePanel rather than a parallel page, so what gets tuned
		// is by construction what gets shipped. DEV-only — the {#if} below is
		// statically false in a production build, so nothing here reaches the Pi.
		const labParam = params.get('lab');
		const isLab = import.meta.env.DEV && (labParam === '1' || labParam === 'true');
		if (isLab) {
			labRenderer = model.config.world.useThreeOverlay ? 'hybrid' : 'cesium';
		}
		labMode = isLab;
	}

	// Media modes force full-bleed: no cabin frame/rivets/passenger HUD over video.
	const isFlightChrome = $derived(model.displayMode === 'flight');
	const showCabinChrome = $derived(isFlightChrome && model.config.shell.windowFrame);
</script>

<svelte:head>
	<title>Aero Window</title>
</svelte:head>

<svelte:window
	onkeydown={handleKey}
	onerror={handleGlobalError}
	onunhandledrejection={handleUnhandledRejection}
/>

<main class={["app", !showCabinChrome && "no-frame"]}>
	<!-- Cabin wall: texture + rivets only when the oval frame is on AND flight.
	     Media is full-bleed — rivets must not paint over the stage. -->
	<div class="cabin-wall">
		{#if showCabinChrome}
			<div class="cabin-texture"></div>
		{/if}

		<Pane />

		<!-- Renders nothing; drives the synthesized cabin ambience. Music is
		     gated to the group leader so three panes can't play a melody a few
		     hundred ms apart — the noise layers are uncorrelated on purpose
		     (see ambient-audio.ts header). -->
		<AmbientAudioHost
			altitudeFt={model.flight.altitude}
			weather={model.weather}
			isLeader={isGroupLeader(model.config.camera.parallax.role)}
		/>

		{#if showCabinChrome}
			<div class="cabin-details">
				<div class="rivet rivet-tl"></div>
				<div class="rivet rivet-tr"></div>
				<div class="rivet rivet-bl"></div>
				<div class="rivet rivet-br"></div>
			</div>
		{/if}
	</div>

	<!-- Passenger HUD only in flight — never over video/slideshow. -->
	{#if isFlightChrome}
		<Controls />
	{/if}

	<!-- Side panel — essentials first; density/lighting/lab behind Advanced.
	     Keeps the ops surface short so auto-close feels natural, not rushed. -->
	<SidePanel>
		<LocationPicker />
		<div class="divider"></div>
		<WeatherPicker />
		<div class="divider"></div>
		<TimeControl />
		<div class="divider"></div>
		<FlightControls />
		<details class="advanced">
			<summary>Advanced</summary>
			<div class="advanced-body">
				<AtmosphereControls />
				<div class="divider"></div>
				<LightingControls />
				<div class="divider"></div>
				<AudioControls />
				{#if import.meta.env.DEV && labMode}
					<div class="divider"></div>
					{#await import('$lib/shell/operator/panel/LabControls.svelte') then { default: LabControls }}
						<LabControls bind:mode={labRenderer} {model} />
					{/await}
				{/if}
			</div>
		</details>
	</SidePanel>

	{#if import.meta.env.DEV && labMode && labRenderer === 'night-lab'}
		{#await import('$lib/shell/operator/panel/NightVariantPanel.svelte') then { default: NightVariantPanel }}
			<NightVariantPanel {model} />
		{/await}
	{/if}

	<!-- Observability viewer (Shift+T to toggle) -->
	<TelemetryPanel />

	<!-- Held first frame — same artwork as the Plymouth theme and X root
	     window, dissolving once the renderer reports real frames. Last child
	     so it covers the shell without the shell needing to know about it. -->
	<BootLockup />
</main>

<style>
	:global(body) {
		margin: 0;
		padding: 0;
		overflow: hidden;
		background: #000;

		/* SouthWest Airlines Branding */
		--sw-blue: #304cb2;
		--sw-blue-rgb: 48, 76, 178; /* --sw-blue channels, for rgba(var(--sw-blue-rgb), a) */
		--sw-yellow: #ffbf27;
		--sw-silver: #cccccc;

		/* Cabin display face — the airline-signage voice for passenger-facing
		   furniture (clock, blind card). NOT a webfont: this kiosk is built to
		   survive losing the client's WiFi, and a gstatic face would fall back
		   to something unchosen at exactly the moment that matters. So it is a
		   stack of faces that genuinely exist on the target.
		   The lineage is airport signage — Frutiger was drawn for CDG, Helvetica
		   for the carriers that followed — and both degrade to a metric or
		   optical relative on Pi OS Bookworm: Piboto is the Pi's own UI face,
		   Liberation Sans is Helvetica-metric. The Pi lands on Piboto.
		   Pair with font-variant-numeric: tabular-nums anywhere digits tick. */
		--sw-font-cabin:
			"Frutiger", "Univers", "Helvetica Neue", Piboto, Roboto,
			"Liberation Sans", "Noto Sans", system-ui, sans-serif;

		font-family:
			"Ubuntu",
			system-ui,
			-apple-system,
			sans-serif;
	}

	.app {
		width: 100vw;
		height: 100vh;
		background: #2a2a2a;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.cabin-wall {
		position: relative;
		width: 100%;
		height: 100%;
		max-width: 3840px;
		max-height: 2160px;
		/* Premium cabin wall — cool pearl white with subtle blue warmth */
		background:
			radial-gradient(ellipse at 50% 0%, rgba(var(--sw-blue-rgb), 0.04) 0%, transparent 60%),
			linear-gradient(
				180deg,
				#eceef2 0%,
				#f0f2f5 15%,
				#f4f5f8 50%,
				#f0f2f5 85%,
				#e8eaee 100%
			);
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow:
			inset 0 0 120px rgba(var(--sw-blue-rgb), 0.04),
			inset 0 -2px 0 rgba(var(--sw-blue-rgb), 0.08),
			0 0 60px rgba(0, 0, 0, 0.25);
	}

	.cabin-texture {
		position: absolute;
		inset: 0;
		pointer-events: none;
		background:
			/* Fine horizontal panel seams */
			repeating-linear-gradient(
				0deg,
				transparent 0px,
				transparent 180px,
				rgba(var(--sw-blue-rgb), 0.025) 180px,
				rgba(var(--sw-blue-rgb), 0.025) 181px,
				transparent 181px
			),
			/* Vertical panel seams */
			repeating-linear-gradient(
				90deg,
				transparent 0px,
				transparent 240px,
				rgba(0, 0, 0, 0.015) 240px,
				rgba(0, 0, 0, 0.015) 241px,
				transparent 241px
			);
	}

	.cabin-details {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}

	.rivet {
		position: absolute;
		width: 7px;
		height: 7px;
		background: radial-gradient(circle at 35% 30%, rgba(255,255,255,0.9), rgba(var(--sw-blue-rgb), 0.3) 60%, rgba(30, 55, 140, 0.6));
		border-radius: 50%;
		box-shadow:
			inset 0 1px 2px rgba(255, 255, 255, 0.8),
			0 1px 3px rgba(0, 0, 0, 0.25),
			0 0 0 1px rgba(var(--sw-blue-rgb), 0.15);
	}

	.rivet-tl {
		top: 12%;
		left: 18%;
	}
	.rivet-tr {
		top: 12%;
		right: 18%;
	}
	.rivet-bl {
		bottom: 12%;
		left: 18%;
	}
	.rivet-br {
		bottom: 12%;
		right: 18%;
	}

	/* Kiosk-only: hide cursor everywhere when html has the .kiosk class
	   (set by app.html based on hostname=localhost). Dev/admin reaching the
	   Pi via its LAN hostname or IP keeps a normal pointer for interaction. */
	:global(html.kiosk),
	:global(html.kiosk *),
	:global(html.kiosk *:hover) {
		cursor: none !important;
	}

	/* Accessibility: reduce motion for DECORATIVE hint animations only.
	   Scene animations (cloud drift, warp, breathing) are the product, not
	   shell, so they keep running regardless of this preference. The old
	   blanket :global(*) rule silently froze the cloud deck on any OS with
	   reduce-motion enabled. */
	@media (prefers-reduced-motion: reduce) {
		:global(.blind-overlay.discoverable::after) {
			animation: none !important;
		}
		:global(.blind-overlay) {
			transition-duration: 0.01ms !important;
		}
	}

	/* Window-frame on/off (Phase 5b).
	   When toggled off via config.shell.windowFrame=false, the cabin wall,
	   texture, and rivets disappear so the Cesium canvas reads edge-to-edge.
	   Pane.svelte handles its own inner shell in the .no-frame scope. */
	.app.no-frame .cabin-wall {
		background: #000;
		box-shadow: none;
	}
</style>
