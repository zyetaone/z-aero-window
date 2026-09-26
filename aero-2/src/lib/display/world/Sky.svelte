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
	import { quantize, slowBeat } from './beat.js';

	const display = useDisplay();

	const night = $derived(display.night);

	/**
	 * How much light the weather has taken out. Shared with Ground, Terrain and
	 * Clouds so the sky cannot disagree with the ground about the weather.
	 */
	const overcast = $derived(weatherLightLoss(display.weather));
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
		const density =
			(display.atmosphere.fogDensity - FOG_MIN_DENSITY) / (FOG_MAX_DENSITY - FOG_MIN_DENSITY);
		const byAltitude = 0.18 + 0.68 * Math.max(0, Math.min(1, density));
		/**
		 * Weather thickens the air on top of altitude.
		 *
		 * Visibility is the cue a passenger reads first: in rain the far ridge
		 * goes, in a storm the middle distance goes too. Pushed toward the
		 * ceiling rather than added, so it cannot exceed the range MapLibre
		 * accepts however the band table is later tuned.
		 */
		/**
		 * Height thickens the view: from cruise the line of sight to the ground
		 * crosses the whole boundary layer at a slant, so the ground softens as
		 * the plane climbs even while the air at the window clears.
		 */
		const slant = 0.22 * Math.max(0, Math.min(1, (display.view.aglM - 5000) / 7000));
		const weathered = Math.min(0.97, byAltitude + slant + (0.97 - byAltitude) * overcast * 0.75);
		/**
		 * Haze comes and goes. Two slow beats (97 s and 151 s, coprime so the
		 * product wanders for hours) swing the ground blend ±0.06 around the
		 * band's value, so the far ridge softens and clears the way real air
		 * does. Pure in wallSec: three panes thicken together. 0.01 steps so
		 * fog-ground-blend is written a few times a minute, not every frame.
		 */
		const drift = slowBeat(display.view.wallSec, 97, 151);
		return quantize(Math.max(0.05, Math.min(0.97, weathered + 0.1 * drift)));
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
	/** Screen percent per degree below the horizon; the moon's placement uses it. */
	const PER_DEGREE = 0.9;
	/**
	 * A cloud/haze DECK as a CSS band, not as sprites or a textured quad: a
	 * gradient below the horizon, aligned to it, that thickens with weather
	 * and only shows while the aircraft is above the deck altitude. Zero
	 * texture memory, one compositing layer, and it rolls with the horizon.
	 */
	const aboveDeck = $derived(
		quantize(Math.max(0, Math.min(1, (display.view.aglM - display.config.cloudAltitudeM - 300) / 600)))
	);
	const deckAmount = $derived(quantize(Math.max(0, Math.min(0.92, overcast * 1.35)) * aboveDeck));
	const deckRgb = $derived(
		lerpRgb([0.93, 0.93, 0.95], [0.15, 0.16, 0.19], night)
			.map((v) => Math.round(v * 255))
			.join(', ')
	);
	/**
	 * The moon: a disc where the sky says it is, phase as a shadow disc
	 * sliding off it. Composition over ephemeris: a degree or two of error
	 * is invisible, a missing moon is not. Fades in through nautical dusk and
	 * out under a deck; hidden when it is behind the cabin (more than 100
	 * degrees off the sightline).
	 */
	const moon = $derived(display.moon);
	const moonHeadingDelta = $derived(signedDelta(display.view.cameraBearingDeg, moon.azimuthDeg));
	const moonX = $derived(quantize(50 + (moonHeadingDelta / 180) * 50, 0.1));
	const moonY = $derived(quantize(horizonPct - moon.elevationDeg * PER_DEGREE, 0.1));
	const moonOpacity = $derived(
		quantize(night * (1 - overcast) * Math.max(0, Math.min(1, (moon.elevationDeg + 1) / 5)))
	);
	const moonVisible = $derived(moonOpacity > 0.02 && Math.abs(moonHeadingDelta) < 100);
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

	<!-- Cloud deck seen from above: a horizon-aligned band, CSS only -->
	{#if display.config.clouds && deckAmount > 0.01}
		<div
			class="haze-deck"
			style:--horizon="{horizonPct}%"
			style:--deck={deckRgb}
			style:opacity={deckAmount}
		></div>
	{/if}

	{#if moonVisible}
		<div
			class="moon"
			style:left="{moonX}%"
			style:top="{moonY}%"
			style:opacity={moonOpacity}
			style:--lit={moon.illumination}
		></div>
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
		/* Oversized: a full-frame rectangle rotated by the roll leaves bare
		   triangles at the corners; 15% of slack covers a 10-degree bank. */
		inset: -15%;
		transform: rotate(var(--roll, 0deg));
		transform-origin: 50% var(--horizon, 40%);
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

	.moon {
		position: absolute;
		width: 2.4vh;
		height: 2.4vh;
		translate: -50% -50%;
		border-radius: 50%;
		overflow: hidden;
		background: radial-gradient(circle at 42% 38%, #fffdf3 0%, #ece6d3 50%, #bdb7a6 100%);
		box-shadow: 0 0 22px 6px rgba(255, 246, 222, 0.28);
	}
	/* Phase: the dark disc slides off the lit one as --lit goes 0 -> 1. */
	.moon::after {
		content: '';
		position: absolute;
		inset: -8%;
		border-radius: 50%;
		background: rgb(9, 11, 20);
		translate: calc(var(--lit, 0) * 118%) 0;
	}

	.haze-deck {
		position: absolute;
		inset: 0;
		/* Clear sky right at the horizon line, the deck filling in below it:
		   thin and far at the top of the band, solid nearer the aircraft. */
		background: linear-gradient(
			to bottom,
			transparent 0,
			transparent calc(var(--horizon) - 1%),
			rgba(var(--deck), 0.45) calc(var(--horizon) + 5%),
			rgba(var(--deck), 0.92) calc(var(--horizon) + 22%),
			rgba(var(--deck), 0.96) 100%
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
