<script lang="ts">
	/**
	 * Roads — the city's own light, drawn as vectors instead of photographed.
	 *
	 * WHY THIS EXISTS: VIIRS stops at z8.
	 *
	 * `TILE_MAXZOOM.viirs` is 8 because the GIBS product ships
	 * GoogleMapsCompatible_Level8 — there is no z9 to ask for. At latitude 40
	 * that is 468 m/px, so as the window descends toward its floor the night
	 * lights are upscaled until a city is one amber smudge. The bright sheet
	 * is doing what it can, but it has no more pixels: the raster is right at
	 * cruise and blurred at approach, and no grade recovers detail a sensor
	 * never had.
	 *
	 * Vectors have no such limit. `data/roads/*.geojson` is 46 MB of OSM
	 * motorway-through-residential already packed for all eight non-feature
	 * locations, already served by `/api/roads/[city]` with ETags — and, until
	 * now, rendered by NOTHING. Nothing under `display/` referenced roads; the
	 * endpoint, its tests and the 46 MB were a delivery path with no consumer.
	 * That is the same shape as the archive bugs in ARCHITECTURE §5: an asset
	 * that is present, plausible and inert, which no health check can see
	 * because everything about it works except that no one asks for it.
	 *
	 * So this layer is not new data. It is the renderer the packed data was
	 * missing, and it happens to be exactly what fixes the z8 ceiling: road
	 * networks ARE the shape of city lighting from the air. Lit arterials over
	 * a dark grid is what a passenger actually sees at 3,000 m.
	 *
	 * It composites OVER viirs rather than replacing it. VIIRS carries the
	 * regional glow — distant towns, ports, everything beyond the packed box —
	 * and this sharpens the city the window is actually over. Same relationship
	 * Sentinel-2 has with MODIS in `Ground.svelte`, and for the same reason: a
	 * per-location box on top of a global wash degrades at the edge instead of
	 * punching a hole.
	 */
	import { GeoJSONSource, LineLayer } from 'svelte-maplibre-gl';
	import { useDisplay } from '../display.svelte.js';
	import {
		hysteresisGate,
		lampFlicker,
		lampGlimmer,
		NIGHT_LIGHT_RAMP,
		NIGHT_MOUNT_OFF,
		NIGHT_MOUNT_ON,
		NIGHT_VECTOR_SPAN_M,
		NIGHT_VECTOR_TOP_M,
		farFieldShare
	} from './sun.js';
	import { Location } from '#lib/locations.js';
	import { quantize, shiftDash } from './beat.js';
	import { weatherLightLoss } from './atmosphere.js';

	const display = useDisplay();

	const place = $derived(display.config.place);
	const night = $derived(display.night);
	const aglM = $derived(display.view.aglM);

	/**
	 * Ramped on NIGHT_LIGHT_RAMP, the same constant as the VIIRS ramp in
	 * `NightLights.svelte` (the old comment said `Ground.svelte` — the ramp
	 * moved with the layer and the comment did not).
	 *
	 * Not a stylistic echo — the two layers draw the same phenomenon and a
	 * linear fade would put streetlights on a sky that is still blue, then
	 * have them lead the raster they are supposed to be sharpening. One
	 * constant, so the vector and the photograph arrive together.
	 */
	const lightUp = $derived(
		Math.min(1, night ** NIGHT_LIGHT_RAMP * Location.moodFor(display.config.place.id).nightGlow)
	);

	/**
	 * Traffic: dashes of uneven length and spacing sliding along the
	 * arterials, MapLibre's own "animate a line" recipe. `line-dasharray`
	 * cannot be offset, so 32 rotations of one irregular pattern are
	 * precomputed (shiftDash) and the wall clock picks one four times a
	 * second: one dasharray write per quarter second, identical on every
	 * pane. Lengths are in line-widths, so the same pattern reads as traffic
	 * spaced to the road's own width at any zoom.
	 */
	/** Dash and gap lengths in line-widths: cars and lorries, bunched and spread. */
	const TRAFFIC_PATTERN = [1, 4, 0.6, 7, 1.4, 3, 0.8, 9, 1.1, 5];
	const TRAFFIC_STEPS = 32;
	const TRAFFIC_PERIOD = TRAFFIC_PATTERN.reduce((a, b) => a + b, 0);
	const TRAFFIC_DASHES = Array.from({ length: TRAFFIC_STEPS }, (_, i) =>
		shiftDash(TRAFFIC_PATTERN, (i / TRAFFIC_STEPS) * TRAFFIC_PERIOD)
	);
	const trafficDash = $derived(
		TRAFFIC_DASHES[Math.floor(display.view.wallSec * 4) % TRAFFIC_STEPS]
	);

	/**
	 * Fades OUT with altitude, which is the opposite of what a detail layer
	 * usually does and is the whole point.
	 *
	 * VIIRS is at its best at cruise, where 468 m/px is finer than the screen
	 * resolves anyway; drawing 30,000 line features up there would cost a Pi
	 * real frames to add nothing a photograph is not already saying. The
	 * vectors earn their keep on the way DOWN, so they arrive as the raster
	 * runs out of pixels. 9,000 m to 4,000 m is the descent window.
	 */
	// 0.01 steps: a raw float per frame is a setPaintProperty per frame.
	const altitudeFade = $derived(
		Math.round(Math.max(0, Math.min(1, (NIGHT_VECTOR_TOP_M - aglM) / NIGHT_VECTOR_SPAN_M)) * 100) / 100
	);

	// A cloud deck sits between the window and the lamps: the same light loss
	// Ground/Sky take, so the city dims WITH the deck instead of burning through it.
	const deck = $derived(weatherLightLoss(display.weather));
	const glow = $derived(quantize(lightUp * altitudeFade * (1 - 0.8 * deck)));

	/**
	 * Far-field arterial dots: the city as seen from cruise.
	 *
	 * The near-field lamps below fade out by 9,000 m, so from the top of
	 * the climb the night city was VIIRS alone — a 468 m/px smudge with
	 * no structure. The arterial skeleton survives as sparse dots on long
	 * gaps: motorway/trunk/primary only, the same continuous lamp-runs the
	 * near layers draw, resolved into the individual heads a passenger
	 * actually sees from altitude. Majors-only is also the performance
	 * bargain: ~7,000 features instead of ~30,000, drawn where the raster
	 * has nothing to say rather than where it is already saying it.
	 *
	 * Steady, not flickering: at these ranges shimmer is invisible, and a
	 * second 5 Hz paint churn for nothing visible is pure Pi heat. It
	 * hands over to the near layers exactly at NIGHT_VECTOR_TOP_M — the
	 * windows share the seam by construction (sun.ts), so no altitude
	 * double-draws or gaps.
	 */
	const far = $derived(lightUp * farFieldShare(aglM));

	/**
	 * Per-road VIIRS gain, stamped offline by tools/stamp-road-glow.mjs.
	 * Lamp-runs through bright ground burn full; rural connectors dim
	 * toward ember. Unstamped packs read 1 — the old flat look, not dark.
	 */
	const viirsGlow = ['coalesce', ['get', 'glow'], 1] as never;

	/**
	 * Feature locations have no roads and never will.
	 *
	 * The Pacific, the Sahara and the Himalayas are `kind: 'feature'` and have
	 * no packed GeoJSON. `serveCityGeojson` answers an empty FeatureCollection
	 * with `x-aero-dataset: missing` and logs it, which is correct behaviour
	 * and still a fetch plus a warning per mount. `Buildings.svelte` gates on
	 * the same predicate; this is not a coincidence worth abstracting yet, but
	 * if a third consumer appears the gate belongs on `Location`.
	 */
	const hasRoads = $derived(!place.isFeature);

	/**
	 * ALTITUDE drives opacity; only DARKNESS drives mounting. They look like
	 * the same knob and they are not, because the two change on wildly
	 * different timescales.
	 *
	 * `CLIMB_PERIOD_SEC` is two dwells (1,200 s), and the climb curve spends
	 * ~62% of each cycle below 9,000 m — so an altitude-gated `{#if}` mounts and
	 * unmounts this source THREE TIMES AN HOUR, every hour, forever. Each mount re-fetches and
	 * re-parses the city's GeoJSON: Denver is 4.4 MB and 19,838 features, which
	 * measures 29 ms of `JSON.parse` on an M-series Mac and is roughly 160 ms on
	 * a Pi 5, on the main thread, in a window whose entire job is to move
	 * smoothly. A periodic stutter with no visible cause is exactly the class of
	 * fault that gets called "the Pi is slow" and never gets found.
	 *
	 * Night is the right mount gate because it is monotonic over hours: the
	 * source mounts at dusk, stays for the night, and leaves at dawn. Two
	 * transitions a day instead of ninety-six.
	 *
	 * This is NOT a reversal of the `raster-opacity: 0` lesson in
	 * SENTINEL2_PLACES. That was about a source that could never have tiles
	 * anywhere, firing a request storm of 404s forever. This is one finite
	 * document that is already in memory and will be needed again in minutes;
	 * holding it at zero opacity costs a paint of nothing, while unmounting it
	 * costs a re-parse. Same syntax, opposite economics — the question is always
	 * whether the mounted-but-invisible thing is doing WORK.
	 */
	// Latched against twilight dither, but TRACKED: `untrack` here evaluated
	// the gate once at mount and froze it, so a dusk boot never mounted the
	// source no matter how dark it got. The hysteresis thresholds (not the
	// untrack) are what stop the blinking; same-value writes don't notify.
	let latched = $state(false);
	$effect(() => {
		latched = hysteresisGate(lightUp, latched, NIGHT_MOUNT_ON, NIGHT_MOUNT_OFF);
	});
	const mounted = $derived(hasRoads && latched);

	/**
	 * Lamp shimmer, sampled at 5 Hz from the wall clock.
	 *
	 * A per-frame derivation would mint a new paint object 60×/s and push a
	 * style update each frame; 5 Hz rides the map's existing RAF renders for
	 * free. The VALUE is a pure function of wall seconds (`lampFlicker`), so
	 * all panes agree — only the sampling instant differs, which is invisible
	 * at these frequencies. Interval-owned, not tick-owned: this component has
	 * no RAF of its own and must not start one for a ±10% shimmer.
	 */
	let wallT = $state(Date.now() / 1000);
	$effect(() => {
		// Timer only while the source is mounted (night); by day there is
		// nothing shimmering and no reason to wake up 5×/s.
		if (!mounted) return;
		const id = setInterval(() => {
			wallT = Date.now() / 1000;
		}, 200);
		return () => clearInterval(id);
	});
	const flicker = $derived(lampFlicker(wallT));
	/**
	 * The glimmer envelope, sampled on the same 5 Hz wall clock as the
	 * flicker above — one sampler, two pure functions, no extra timer.
	 */
	const glimmer = $derived(lampGlimmer(wallT));

	/**
	 * Opacity expressions: the altitude/night scalar and the 5 Hz shimmer
	 * stay reactive numbers; the VIIRS gain is a per-feature expression.
	 * MapLibre multiplies them per lamp-run, so a motorway through the
	 * dark prairie draws dimmer than the same class downtown. Declared
	 * after the shimmer sampler they read — declaration order is the
	 * dependency order here.
	 */
	const bloomOpacity = $derived(['*', 0.22 * glow, viirsGlow] as never);
	const casingOpacity = $derived(['*', 0.8 * glow, viirsGlow] as never);
	const majorOpacity = $derived(['*', 0.55 * glow, flicker, viirsGlow] as never);
	const glimmerOpacity = $derived(['*', 0.4 * glow, glimmer, viirsGlow] as never);
	const minorOpacity = $derived(['*', 0.5 * glow, flicker, viirsGlow] as never);
	const farOpacity = $derived(['*', 0.75 * far, viirsGlow] as never);

	/**
	 * Arterials vs the minor grid, as filters.
	 *
	 * The packed GeoJSON carries only `class`, so this is the finest split
	 * the data supports — which is enough, because the night city really is
	 * two phenomena: continuous lamp-runs along the arterials, and scattered
	 * dots on the residential grid.
	 */
	// Flat label pairs: `match` takes one label per output, not an array.
	const majorFilter = [
		'match',
		['get', 'class'],
		'motorway',
		true,
		'trunk',
		true,
		'primary',
		true,
		false
	] as never;
	const minorFilter = [
		'match',
		['get', 'class'],
		'motorway',
		false,
		'trunk',
		false,
		'primary',
		false,
		true
	] as never;

	/**
	 * Width by class, in screen pixels, interpolated across zoom.
	 *
	 * A motorway is ~4x a residential street on the ground, but drawn light
	 * does not scale that way: sodium and LED arterials bloom, so the ratio
	 * that reads correctly is nearer 3x with the small roads kept ABOVE a
	 * hairline. Sub-pixel lines alias into a dotted mess under motion, which
	 * on a window that is always moving is the one artefact you cannot look
	 * away from — hence the 0.4 floor rather than a proportional taper to
	 * zero.
	 *
	 * Built by a factory rather than written twice because the bloom pass is
	 * the same curve at 3x, and `['*', width, 3]` is NOT a legal way to say
	 * that: MapLibre requires `["zoom"]` to be the direct input of a top-level
	 * `interpolate`, so wrapping the interpolate in a multiply is rejected at
	 * style-load time. That error is thrown during map init, which means it
	 * takes the whole kiosk page down — `svelte-check` and all 215 unit tests
	 * were green on it, and `bun run smoke` is what caught it. Scaling the
	 * STOP VALUES keeps the expression top-level.
	 */
	const widthAt = (scale: number) =>
		[
			'interpolate',
			['linear'],
			['zoom'],
			8,
			[
				'match',
				['get', 'class'],
				'motorway',
				1.1 * scale,
				'trunk',
				0.9 * scale,
				'primary',
				0.7 * scale,
				0.4 * scale
			],
			13,
			[
				'match',
				['get', 'class'],
				'motorway',
				3.4 * scale,
				'trunk',
				2.8 * scale,
				'primary',
				2.2 * scale,
				'secondary',
				1.6 * scale,
				1.0 * scale
			]
		] as never;

	const width = $derived(widthAt(1));
	const bloomWidth = $derived(widthAt(3));
	/**
	 * Dark roadbed casing, 1.7x the lamp width.
	 *
	 * The classic map casing pattern: a dark underlay wider than the bright
	 * core, so each lamp-run reads as lights ON a road instead of a filament
	 * floating over the photograph. It also contains the bloom — the halo's
	 * mushy edge lands on dark asphalt rather than glowing ground. Steady
	 * (no flicker): it is roadbed, not lamp.
	 */
	const casingWidth = $derived(widthAt(1.7));
	const casingColor = '#17110b';

	/**
	 * Sodium amber for the big roads, cooler white for the small grid.
	 *
	 * Backwards from the intuition that motorways are the modern LED ones, and
	 * deliberately so: from altitude the arterials are the continuous lit runs
	 * and the residential grid reads as scattered cooler points. Picking the
	 * warm tone for the DOMINANT line keeps the overall cast matching VIIRS
	 * underneath, which is strongly amber. Two vector colours against one
	 * raster colour is already the limit of what stays coherent.
	 */
	const color = $derived([
		'match',
		['get', 'class'],
		'motorway',
		'#ffb959',
		'trunk',
		'#ffab45',
		'primary',
		'#ffa63c',
		'#e8d9c0'
	] as never);
</script>

{#if mounted}
	<GeoJSONSource id="city-roads" data="/api/roads/{place.id}">
		<!-- Two passes: a wide soft bloom, then the filament on top.
		     One line at one width reads as a wire diagram — the give-away that
		     it is drawn rather than lit. Real lighting spills, and the cheap
		     way to say so is a blurred underlay at a fraction of the opacity.
		     `line-blur` on a single pass cannot do it: blurring the only pass
		     dims the core along with the edge. -->
		<LineLayer
			id="city-roads-bloom"
			paint={{
				'line-color': color,
				'line-width': bloomWidth,
				'line-blur': 3,
				'line-opacity': bloomOpacity
			}}
			layout={{ 'line-cap': 'round', 'line-join': 'round' }}
		/>
		<!-- Traffic: irregular dashes sliding along the arterials, one dasharray
		     write per quarter second from the wall clock (see trafficDash). -->
		<LineLayer
			id="city-roads-traffic"
			filter={['in', ['get', 'class'], ['literal', ['motorway', 'trunk', 'primary']]]}
			paint={{
				'line-color': '#fff1c9',
				'line-width': width,
				'line-opacity': 0.9 * glow,
				'line-dasharray': trafficDash
			}}
			layout={{ 'line-cap': 'round', 'line-join': 'round' }}
		/>
		<!-- Roadbed casing under the lamps: dark outline, solid, steady. -->
		<LineLayer
			id="city-roads-casing"
			paint={{
				'line-color': casingColor,
				'line-width': casingWidth,
				'line-blur': 0,
				'line-opacity': casingOpacity
			}}
			layout={{ 'line-cap': 'round', 'line-join': 'round' }}
		/>
		<!-- Lamp runs, not paint runs. The old core was one solid filament at
		     0.85 — a wire diagram — and the next iteration's [2.5, 1.2] dashes
		     read as runway edge-lights: too long, too even, too coherent. Real
		     arterials are individual lamp heads with dark gaps between them, so
		     the majors are short dots on long gaps, and the GLIMMER pass runs a
		     second, sparser dash train at an incommensurate period under a
		     deeper envelope: where the trains cross, lamps flare and die one by
		     one instead of the whole run breathing in unison. Both envelopes are
		     pure wall-clock functions, so every pane shimmers identically. -->
		<LineLayer
			id="city-roads-lamps-major"
			filter={majorFilter}
			paint={{
				'line-color': color,
				'line-width': width,
				'line-blur': 1,
				'line-opacity': majorOpacity,
				'line-dasharray': [1.5, 2.4]
			}}
			layout={{ 'line-cap': 'round', 'line-join': 'round' }}
		/>
		<LineLayer
			id="city-roads-glimmer"
			filter={majorFilter}
			paint={{
				'line-color': color,
				'line-width': width,
				'line-blur': 2,
				'line-opacity': glimmerOpacity,
				'line-dasharray': [0.9, 4.2]
			}}
			layout={{ 'line-cap': 'round', 'line-join': 'round' }}
		/>
		<LineLayer
			id="city-roads-lamps-minor"
			filter={minorFilter}
			paint={{
				'line-color': color,
				'line-width': width,
				'line-blur': 1,
				'line-opacity': minorOpacity,
				'line-dasharray': [0.4, 3]
			}}
			layout={{ 'line-cap': 'round', 'line-join': 'round' }}
		/>
		<!-- Far-field arterial dots: the lamp-runs above resolved into
		     individual heads. Same majors filter as the near lamps, a much
		     sparser train so that at cruise zooms each dash is one lamp,
		     not a segment. Steady opacity (no flicker — see above),
		     VIIRS-weighted like everything else on this source.
		     Zoom-stepped, because dash lengths multiply by line width and
		     the cruise width is ~1 px: a fixed [0.6, 7] draws 0.66 px dots
		     up high, which alias into shimmer under motion on a window that
		     never stops moving. Integer-zoom steps only (the spec evaluates
		     dash zooms at integer levels) — dots stay ≥2 px at cruise and
		     resolve fine on the way down. -->
		<LineLayer
			id="city-roads-far-dots"
			filter={majorFilter}
			paint={{
				'line-color': color,
				'line-width': width,
				'line-blur': 1,
				'line-opacity': farOpacity,
				'line-dasharray': [
					'interpolate',
					['linear'],
					['zoom'],
					8,
					['literal', [2, 9]],
					11,
					['literal', [0.6, 7]]
				] as never
			}}
			layout={{ 'line-cap': 'round', 'line-join': 'round' }}
		/>
	</GeoJSONSource>
{/if}
