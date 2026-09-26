<script lang="ts">
	/**
	 * Sky — Unified Circadian Atmosphere, Sky Dome, Solar Radiance & Milky Way.
	 *
	 * Unifies:
	 * 1. MapLibre 3D Sky Dome (<SkyDome>): Rayleigh scattering, horizon mist band,
	 *    and terrain distance fog.
	 * 2. Circadian Celestial Layer: Solar flare radiance at dusk/dawn and the
	 *    diffuse Milky Way wash at night, fully synchronized with `display.sun`,
	 *    `display.night`, and local destination solar time. Crisp stars live
	 *    in-map (`Starfield.svelte`), where the depth buffer occludes them.
	 */
	import { Sky as SkyDome } from 'svelte-maplibre-gl';
	import { WORLD_ROLL_GAIN } from '../flight/view.js';
	import { useDisplay } from '../display.svelte.js';
	import { facingSunAmount } from './sun.js';
	import { signedDelta } from '#lib/angles.js';
	import { cssRgb, lerpRgb, weatherLightLoss } from './atmosphere.js';
	import {
		resolveFogColor,
		resolveSkyHorizonColor,
		resolveSkyTopColor,
		skyHorizonPct
	} from './sky-colors.js';

	const display = useDisplay();

	const night = $derived(display.night);

	/**
	 * How much light the weather has taken out. Shared with Ground, Terrain and
	 * Clouds so the sky cannot disagree with the ground about the weather.
	 */
	const overcast = $derived(weatherLightLoss(display.config.weather));
	const sunElev = $derived(display.sun.elevationDeg);
	const sunAzimuth = $derived(display.sun.azimuthDeg);

	// ── 1. Circadian & Solar-Graded Sky Vault Colors ──────────────────────────
	// Bodies live in sky-colors.ts: the dome here and the SkyBackdrop gradient
	// must compute the same sky or the wall shows a seam.
	const skyInputs = $derived({
		baseTop: display.atmosphere.skyTop,
		baseHorizon: display.atmosphere.skyHorizon,
		sunElevDeg: sunElev,
		night,
		overcast,
		placeId: display.config.place.id
	});
	const skyTop = $derived(resolveSkyTopColor(skyInputs));
	const skyHorizon = $derived(resolveSkyHorizonColor(skyInputs));

	/**
	 * Where the sun is relative to where the window is POINTING, -180..180.
	 *
	 * Declared up here because two different things need it: the fog tint just
	 * below, and the dusk glare's screen position further down. It used to be
	 * defined next to the glare, which is why the fog never had it.
	 */
	const sunHeadingDelta = $derived(signedDelta(display.view.cameraBearingDeg, sunAzimuth));

	/** Shared with the water sheen — see `facingSunAmount`. */
	const facingSun = $derived(facingSunAmount(display.view.cameraBearingDeg, sunAzimuth));

	const fogColor = $derived.by(() => {
		const nightFog: readonly [number, number, number] = [0.04, 0.07, 0.15];

		const blendedDay = resolveFogColor(skyInputs);

		/**
		 * Haze brightens TOWARDS the sun. This is the single most recognisable
		 * thing about looking out of an aeroplane, and it was missing.
		 *
		 * Atmospheric haze is forward-scattering — the same Mie term the cloud
		 * deck already models per-sprite — so the horizon ahead of the sun is
		 * pale and washed out while the horizon behind it stays saturated and
		 * blue. Sitting on the sunward side of the aircraft is a completely
		 * different view from the shaded side, and that asymmetry is most of
		 * why a window seat looks like a window seat.
		 *
		 * The fog was one flat colour for the whole dome, so both sides of the
		 * aeroplane got the identical horizon. Worse on this product than on a
		 * normal map: the three panes of the wall point at three different
		 * bearings, so the ONE cue that would distinguish them was the one not
		 * being drawn, and the panorama read as three copies of the same haze.
		 *
		 * Deliberately subtle. This tints an existing colour rather than adding
		 * a glare — `dusk-radiance` already owns the low-sun flare, and two
		 * layers competing to draw the same sun is how the horizon turns to
		 * mud. Scaled by `(1 - night)` because there is nothing to forward-
		 * scatter after dark, and by elevation because a high sun scatters far
		 * less into the horizon than a low one.
		 */
		const lowSun = 1 - Math.max(0, Math.min(1, sunElev / 40));
		// Forward scatter needs a sun disc to scatter FROM. Under thick cloud the
		// light is diffuse and the sunward horizon stops being brighter than any
		// other, so the whole term fades out with the weather.
		const scatter = facingSun * lowSun * (1 - night) * (1 - overcast) * 0.42;
		const sunwardHaze: readonly [number, number, number] = [0.94, 0.88, 0.78];

		return lerpRgb(lerpRgb(blendedDay, sunwardHaze, scatter), nightFog, night);
	});

	/**
	 * Fog thickness, mapped from the band's own `fogDensity`.
	 *
	 * This was `clamp(fogDensity * 2400, 0.65, 0.95)`, and the floor was doing
	 * almost all the work: four of the five bands multiplied out BELOW 0.65
	 * (ground 0.24, haze 0.60, cirrus 0.48, stratosphere 0.19), so they were all
	 * forced to the same 0.65 and only midDeck ever exceeded it. The window sat
	 * in near-constant haze whatever the altitude, and the band model — the
	 * thing that is supposed to make climbing feel like climbing — could not be
	 * seen.
	 *
	 * Now the band's density is mapped across the full range with no floor, so
	 * ground reads 0.22, midDeck still peaks at 0.86, and the stratosphere
	 * clears to 0.18. midDeck stays the thickest band on purpose: that is where
	 * the cloud deck lives.
	 */
	const FOG_MIN_DENSITY = 0.8e-4;
	const FOG_MAX_DENSITY = 4.0e-4;
	const groundBlend = $derived.by(() => {
		const t =
			(display.atmosphere.fogDensity - FOG_MIN_DENSITY) / (FOG_MAX_DENSITY - FOG_MIN_DENSITY);
		const byAltitude = 0.18 + 0.68 * Math.max(0, Math.min(1, t));
		/**
		 * Weather thickens the air on top of altitude.
		 *
		 * Visibility is the cue a passenger reads first: in rain the far ridge
		 * goes, in a storm the middle distance goes too. Pushed toward the
		 * ceiling rather than added, so it cannot exceed the range MapLibre
		 * accepts however the band table is later tuned.
		 */
		return byAltitude + (0.97 - byAltitude) * overcast * 0.75;
	});

	// ── 2. Celestial Solar Radiance & Milky Way ──────────────────────────────
	// Crisp stars moved in-map (`Starfield.svelte`): a DOM overlay above the
	// canvas can only hide behind a flat mask line, so relief and roll put
	// stars over terrain. What stays here is diffuse — dusk glare and the
	// milky-way wash — which cannot read as a dead pixel wherever it lands.
	const duskFactor = $derived(Math.max(0, Math.min(1, (12 - Math.abs(sunElev)) / 12)));
	const sunScreenX = $derived(50 + (sunHeadingDelta / 180) * 50);

	/**
	 * Roll the overlay WITH the map, by the same angle with the matching sign.
	 *
	 * Stage.svelte flies the camera with `roll: -bank * WORLD_ROLL_GAIN`, and
	 * a camera rolled +9.9° shows the world rotated −9.9° on screen (the left
	 * horizon rises when banking left). This overlay is DOM above the canvas,
	 * so it must reproduce that screen rotation itself: `bank * GAIN` is
	 * exactly −(map roll). The old `rotate(var(--view-bank))` was removed when
	 * bank reached the world as pitch-only and the two disagreed; now the map
	 * takes real roll, so NOT rotating is the mismatch — every turn tilted the
	 * rendered horizon away from the mask line and spilled stars onto terrain.
	 */
	const overlayRoll = $derived(display.view.bankDeg * WORLD_ROLL_GAIN);

	/**
	 * Where the horizon sits down the glass, as a percentage from the top.
	 *
	 * Masks the diffuse night wash (milky way, dusk glare) to the region above
	 * the horizon. Shared with the SkyBackdrop gradient (see sky-colors.ts) —
	 * one horizon or the seam shows.
	 */
	const horizonPct = $derived(skyHorizonPct(display.view.cameraPitchDeg));
</script>

<!-- MapLibre 3D Sky Dome, Rayleigh Haze & Horizon Mist -->
<SkyDome
	sky-color={cssRgb(skyTop)}
	horizon-color={cssRgb(skyHorizon)}
	fog-color={cssRgb(fogColor)}
	sky-horizon-blend={0.75}
	horizon-fog-blend={0.82}
	fog-ground-blend={groundBlend}
	atmosphere-blend={0.85}
/>

<!-- Circadian Celestial Layer: Solar Radiance & Milky Way -->
<div
	class="sky-celestial-overlay"
	style:--night={night}
	style:--dusk={duskFactor}
	style:--sun-x="{sunScreenX}%"
	style:--horizon="{horizonPct}%"
	style:rotate="{overlayRoll}deg"
	aria-hidden="true"
>
	<!-- Golden Hour Solar Flare Radiance -->
	{#if duskFactor > 0.05}
		<div class="dusk-radiance" style:opacity={duskFactor * (1 - night)}></div>
	{/if}

	<!-- Diffuse Milky Way wash (fades in at night). Crisp stars are in-map now. -->
	<div class="sky-night" style:opacity={night} style:--horizon="{horizonPct}%">
		<div class="milky-way"></div>
	</div>
</div>

<style>
	/* This used to `rotate(var(--view-bank))`, on the stated grounds that the
	   horizon tilts with the airframe. It does not. Bank never reaches the map
	   as roll -- `calculateCameraOptionsFromTo` derives bearing and pitch from
	   geometry and has nothing to derive roll from, and nothing else sets it --
	   so bank reaches the WORLD as a pitch offset (BANK_VIEW_GAIN) and reached
	   this OVERLAY as a rotation. One input, two different visual answers: the
	   stars banked against a horizon that had stayed level, which made the mask
	   error above worse rather than cancelling it.

	   Rolling the map instead is the other way to make these agree, and is
	   probably the better-looking one -- MapLibre takes `roll` in CameraOptions
	   -- but bank is already spent on pitch, so it needs that double-count
	   resolved first. That is a camera design decision, not a bug fix.

	   UPDATE: Stage now flies real `roll` (bank * WORLD_ROLL_GAIN on top of the
	   pitch coupling), so the premise flipped -- the overlay rotates by
	   `overlayRoll` to match. Same angle the camera got, negated to screen
	   space; the mask line tracks the rendered horizon through turns. */
	.sky-celestial-overlay {
		position: absolute;
		inset: 0;
		overflow: hidden;
		pointer-events: none;
		z-index: 1;
	}

	.dusk-radiance {
		position: absolute;
		bottom: 20%;
		left: var(--sun-x);
		width: 140vw;
		height: 60vh;
		translate: -50% 50%;
		background: radial-gradient(
			ellipse at center,
			rgba(255, 140, 40, 0.75) 0%,
			rgba(240, 90, 60, 0.45) 35%,
			rgba(140, 40, 110, 0.2) 65%,
			transparent 85%
		);
		filter: blur(24px);
		pointer-events: none;
		/* Same horizon mask as the night wash: the glare is sky light and
		   must not wash over foreground terrain. It cannot live inside the
		   night-gated container (dusk happens while night is ~0), so it
		   carries its own copy of the mask off the shared --horizon. */
		mask-image: linear-gradient(
			to bottom,
			#000 0,
			#000 calc(var(--horizon) - 12%),
			transparent var(--horizon)
		);
	}

	.sky-night {
		position: absolute;
		inset: 0;
		/* No `transition` here. `night` is derived from the sun and already
		   moves smoothly; a CSS transition on it would make the fade a function
		   of each pane's frame timing rather than of the wall clock. */
		/* Sky only, faded rather than cut so the boundary does not draw a hard
		   line across the haze. Only diffuse light lives here now (crisp stars
		   moved in-map), so the straight mask line's worst case is a soft glow
		   grazing a ridgeline — never a star pasted on a mountain. */
		mask-image: linear-gradient(
			to bottom,
			#000 0,
			#000 calc(var(--horizon) - 12%),
			transparent var(--horizon)
		);
	}

	.milky-way {
		position: absolute;
		top: -20%;
		left: 10%;
		width: 120%;
		height: 100%;
		rotate: -35deg;
		background: radial-gradient(
			ellipse 80% 30% at 50% 50%,
			rgba(130, 160, 220, 0.18) 0%,
			rgba(90, 120, 180, 0.08) 45%,
			transparent 75%
		);
		filter: blur(32px);
	}
</style>
