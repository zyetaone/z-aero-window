<script lang="ts">
	/**
	 * Stage — the MapLibre viewport and the flight loop that drives it.
	 *
	 * Everything visible inside it is a child component: Ground (colour),
	 * Terrain (shape), Sky (air and haze), LookControls (aiming). This file owns
	 * exactly one thing — where the camera is, every frame.
	 */
	import { untrack } from 'svelte';
	import { MapLibre, Projection, Light } from 'svelte-maplibre-gl';
	import { LngLat, type Map as MlMap } from 'maplibre-gl';
	// Bundled locally. svelte-maplibre-gl otherwise injects a <link> to unpkg,
	// which CSP blocks — and which a fielded Pi has no internet to fetch. Hence
	// `autoloadGlobalCss={false}` on every MapLibre below.
	import 'maplibre-gl/dist/maplibre-gl.css';
	// Calls setWorkerUrl(). MapLibre v6 has no worker without it.
	import 'svelte-maplibre-gl/vite';

	import { useDisplay } from '../display.svelte.js';
	import { resolveClearance, smoothDatum } from './clearance.js';
	import { WORLD_ROLL_GAIN } from '../flight/view.js';
	import Ground from './Ground.svelte';
	import SkyBackdrop from './SkyBackdrop.svelte';
	import Starfield from './Starfield.svelte';
	import SunMoon from './SunMoon.svelte';
	import Terrain from './Terrain.svelte';
	import Buildings from './Buildings.svelte';
	import Water from './Water.svelte';
	import NightLights from './NightLights.svelte';
	import LiveWeather from './LiveWeather.svelte';
	import Roads from './Roads.svelte';
	import Towns from './Towns.svelte';
	import Terminator from './Terminator.svelte';
	import Sky from './Sky.svelte';
	import LookControls from '../flight/LookControls.svelte';

	const BLANK_STYLE = { version: 8 as const, sources: {}, layers: [] };

	const display = useDisplay();

	let map = $state<MlMap | undefined>();
	$effect(() => {
		if (map) (globalThis as unknown as { __stage?: MlMap }).__stage = map;
	});

	/**
	 * Anchor gate for the in-map sky layers (stars, sun/moon).
	 *
	 * They insert `beforeId="gibs-day"` — below the ground photograph, so the
	 * photo covers any star the depth buffer misses. But the wrapper defers the
	 * ground source's own add to a microtask while the sky layers queue
	 * synchronously, so at the first style flush `gibs-day` does not exist yet
	 * and both inserts throw. The throw aborts that flush AND every later one
	 * replays the same stale insert first, so without this gate the sky layers
	 * never mount and the console fills with one error per styledata, forever.
	 * Measured live: `Cannot add layer "night-stars" before non-existing layer
	 * "gibs-day"`, persisting 30 s+ after boot with a loaded style.
	 *
	 * `map.loaded()` cannot be the gate: the camera flies every frame, tiles
	 * never settle, and it reads false for the whole session. The explicit
	 * layer probe is the thing actually needed.
	 */
	let skyAnchorReady = $state(false);
	$effect(() => {
		const m = map;
		skyAnchorReady = false;
		if (!m) return;
		if (m.getLayer('gibs-day')) {
			skyAnchorReady = true;
			return;
		}
		const pin = () => {
			if (m.getLayer('gibs-day')) skyAnchorReady = true;
		};
		m.on('styledata', pin);
		return () => {
			m.off('styledata', pin);
		};
	});

	/**
	 * Fly the plane.
	 *
	 * The camera is positioned by real ALTITUDE and aimed at a real ground
	 * point, via `calculateCameraOptionsFromTo`, rather than faked with a zoom
	 * level.
	 */
	$effect(() => {
		const m = map;
		if (!m) return;

		/**
		 * Smoothed clearance datum — see `smoothDatum` in clearance.ts for
		 * the policy (instant climbs, gliding falls, standing margin).
		 * `queryTerrainElevation` returns null until its DEM tile loads, so
		 * the ground under the camera steps from the regional mean to the
		 * sampled height mid-flight. Worst where the mean lies most:
		 * Himalayan mean 5,000 m against 8,000 m+ sampled ridges.
		 */
		let smoothGround: number | null = null;
		let lastMs = 0;

		let raf: number;
		let loopErrors = 0;
		const loop = () => {
			// Scheduled FIRST: whatever below throws, the next frame still
			// comes. The old shape scheduled at the end, so a single bad
			// frame (a pre-load camera call, a NaN from a fresh place) killed
			// the map forever while the HUD kept ticking on its own loop —
			// the frozen-map-black-window failure, silent because RAF
			// exceptions never reach a Svelte boundary.
			raf = requestAnimationFrame(loop);
			try {
				frame();
			} catch (err) {
				loopErrors++;
				if (loopErrors <= 3) {
					console.warn(
						`[Stage] frame ${loopErrors} dropped:`,
						err instanceof Error ? err.message : String(err)
					);
				}
			}
		};
		const frame = () => {
			const nowMs = performance.now();
			const dtSec = lastMs === 0 ? 0 : Math.min(0.5, (nowMs - lastMs) / 1000);
			lastMs = nowMs;
			const v = display.advanceTo(Date.now() / 1000);
			const planeAt = new LngLat(v.lon, v.lat);
			const targetAt = new LngLat(v.targetLon, v.targetLat);

			/**
			 * Ask the TERRAIN how high the ground is, do not assume the mean.
			 *
			 * `place.groundElevationM` is one number for a whole city, but the
			 * terrain under the aircraft is a 3D mesh AND it is drawn with
			 * `exaggeration`, so what is rendered is the real elevation times that
			 * factor. Adding AGL to the mean therefore puts the camera INSIDE high
			 * ground: at the climb floor, Hyderabad sat at 900 m against Deccan
			 * highs rendered at 1,750 m, and Denver at 4,600 m against a Front
			 * Range rendered at 10,875 m. The window filled with hillside.
			 *
			 * `queryTerrainElevation` returns the drawn height, exaggeration
			 * included, which is exactly the surface we must stay above. It
			 * returns null before the DEM tile covering that point has loaded, so
			 * the mean remains the fallback — and the floor either way, so a
			 * not-yet-loaded tile can never drop the camera.
			 */
			/**
			 * The FALLBACK must be exaggerated too, or it is not the same quantity.
			 *
			 * `queryTerrainElevation` returns the DRAWN height, exaggeration
			 * included -- that is the whole reason it is asked. The flat mean it
			 * falls back to was raw metres MSL, so the two branches returned
			 * values in different units and the fallback was `exaggeration` times
			 * too low. Nothing showed this while the DEM stopped at 79.9E, because
			 * the fallback only bites where the query returns nothing.
			 *
			 * The moment the Himalayas were packed in, it bit hard: mean 5,000 m
			 * drawn at 2.5x is ~12,500 m, the camera was placed at 5,000 + 3,500
			 * AGL = 8,500 m, and the window went black -- 4 km inside the
			 * mountain. Dubai survived only because a 5 m mean is still 12 m when
			 * exaggerated.
			 */
			// Both sides in MapLibre's frame: `queryTerrainElevation` returns the
			// DRAWN height, so the mean is exaggerated to match before comparing.
			const exaggeration = display.config.exaggeration;
			const meanGroundM = display.config.place.groundElevationM * exaggeration;
			const atPlane = resolveClearance(meanGroundM, m.queryTerrainElevation(planeAt));
			const atTarget = resolveClearance(meanGroundM, m.queryTerrainElevation(targetAt));
			display.noteClearance(atPlane.sampled);

			const target = atPlane.groundM;
			smoothGround = smoothDatum(smoothGround, target, dtSec);

			const cam = m.calculateCameraOptionsFromTo(
				planeAt,
				v.aglM + smoothGround,
				targetAt,
				atTarget.groundM
			);
			// Publish the datum the camera just cleared, so the Hud's ALT
			// number names what it is above. Replaced, not mutated: `view`
			// is $state.raw and only assignment notifies, which is also why
			// this rides along on the object advanceTo already assigns.
			display.view = { ...v, groundM: smoothGround };

			/**
			 * Bank rolls the WORLD. This is what makes the wing look attached.
			 *
			 * `calculateCameraOptionsFromTo` derives bearing and pitch from
			 * geometry and has nothing to derive roll from, so until now bank
			 * reached the world only as a pitch offset (BANK_VIEW_GAIN) — the
			 * sightline dipped and lifted through a turn while the horizon stayed
			 * dead level. Meanwhile the wing rolled by its aeroelastic FLEX term
			 * alone: 0.72 deg at a full 18 deg bank, against 6 deg of camera
			 * depression. A wing that barely moves while the view swings is a wing
			 * pasted onto the glass, and that mismatch is the single loudest tell
			 * that this is a map and not a window.
			 *
			 * `roll` is negated because MapLibre rotates the camera and the world
			 * appears to counter-rotate: banking left (negative bankDeg, left wing
			 * down) must tip the horizon so the left side rises in frame.
			 *
			 * `Sky.svelte` already reasoned this out and deferred it — "probably
			 * the better-looking one ... but bank is already spent on pitch, so it
			 * needs that double-count resolved first". That is resolved here: the
			 * pitch coupling stays (it is what reveals ground on the inside of a
			 * turn, and the ratio form cannot cross the horizon), and roll is
			 * added on top at a fraction, so the two read as one aircraft rather
			 * than double-counting into a barrel roll.
			 */
			m.jumpTo({ ...cam, roll: -v.bankDeg * WORLD_ROLL_GAIN });
		};

		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	});

	// Dynamic spherical solar light vector [r, azimuth, polarAngle]
	const sunPos = $derived.by<[number, number, number]>(() => [
		100,
		display.sun.azimuthDeg,
		Math.max(0, 90 - display.sun.elevationDeg)
	]);
</script>

<div class="world-stage">
	<!-- MSAA for the vector edges (lamp dots, casings, extrusions): the map
	     canvas never had it — only the Three overlay did — so every sub-pixel
	     line shimmered under motion. One context-creation flag, no per-frame
	     cost beyond the resolve. Pi cost is real but this is the single
	     highest-leverage AA available to the map stack; if the thermal
	     throttle ever points here, this is the first flag to gate at boot (it
	     cannot be toggled on a live context). -->
	<MapLibre
		bind:map
		autoloadGlobalCss={false}
		class="fill"
		style={BLANK_STYLE}
		center={untrack(() => [display.config.place.lon, display.config.place.lat])}
		zoom={9}
		maxPitch={88}
		anisotropicFilterPitch={20}
		attributionControl={false}
		canvasContextAttributes={{ antialias: true }}
	>
		<!-- 3D Spherical Earth Globe Projection & Solar Lighting -->
		<!-- Mercator, not globe: MapLibre 6.6's globe path ignores raster-brightness
		     and the sky colours below zoom 12, which is the whole flight envelope.
		     Measured 2026-09-22: at 12 km the sky was grey and the night ground
		     daylight-bright until the projection was flipped live. -->
		<Projection type="mercator" />
		<Light anchor="map" position={sunPos} />

		<Ground />
		<!-- Opaque sky backstop, beforeId `gibs-day`: the MapLibre dome mixes
		     its own gradient to transparent in a settled globe view (see
		     sky-colors.ts), so without this the zenith is canvas-black at
		     cruise in daylight. Mounted BEFORE Starfield: same anchor, and
		     inserts stack ahead of it in mount order, so the gradient lands
		     underneath the stars. Same anchor gate for the same reason. -->
		{#if skyAnchorReady}
			<SkyBackdrop />
		{/if}
		<!-- In-map night stars, beforeId `gibs-day`: above the SkyBackdrop
		     gradient, below the ground photograph, which covers anything depth
		     missed. Gated on the anchor (see `skyAnchorReady` above): mounting
		     earlier throws inside the wrapper's style queue and poisons every
		     retry after it. -->
		{#if skyAnchorReady}
			<Starfield />
		{/if}
		<!-- World-fixed sun/moon discs, occluded by terrain like the stars. -->
		{#if skyAnchorReady}
			<SunMoon />
		{/if}
		<Terrain />
		<!-- Above the hillshade, below the lights. The glint is REFLECTED light,
		     so unlike the city lights it belongs on the same side of the shading
		     as the photograph it sits on — but it must not be dimmed by relief
		     that has nothing to do with a lake surface, so it goes after. -->
		<Water />
		<!-- The terminator darkens the photograph on the night side; the
		     lights below must keep glowing through it, so this sits before
		     NightLights by mount order (no stable beforeId exists). -->
		<Terminator />
		<!-- Above Terrain, deliberately: the hillshade shades the ground
		     PHOTOGRAPH, and city lights are emitted, not reflected. See
		     NightLights.svelte. -->
		<NightLights />
		<Towns />
		<Roads />
		<Buildings />
		<Sky />
		<LookControls />
	</MapLibre>
	<!-- No canvas, no DOM: polls /api/weather and authors config.weather. -->
	<LiveWeather />
</div>

<style>
	.world-stage {
		position: absolute;
		inset: 0;
	}
	:global(.fill) {
		position: absolute;
		inset: 0;
	}
</style>
