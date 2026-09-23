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
	import { quantize, slowBeat } from './beat.js';

	const display = useDisplay();

	const place = $derived(display.config.place);
	const night = $derived(display.night);
	const aglM = $derived(display.view.aglM);

	/**
	 * Ramped on night^1.5, matching the VIIRS ramp in `Ground.svelte`.
	 *
	 * Not a stylistic echo — the two layers draw the same phenomenon and a
	 * linear fade would put streetlights on a sky that is still blue, then
	 * have them lead the raster they are supposed to be sharpening. One curve,
	 * so the vector and the photograph arrive together.
	 */
	const lightUp = $derived(Math.min(1, night ** 1.5));
	/**
	 * Lamps shimmer. Sodium and LED strings seen through 3-6 km of air never
	 * hold one brightness: heat and haze make them swim. Two quick beats swing
	 * the cores between 0.5 and 1.0 together (dasharray cannot blink per lamp;
	 * the eye reads a whole string breathing as scintillation). 0.01 steps.
	 */
	const shimmer = $derived(quantize(0.75 + 0.25 * slowBeat(display.view.wallSec, 1.7, 2.9)));

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
	const altitudeFade = $derived(Math.round(Math.max(0, Math.min(1, (9000 - aglM) / 5000)) * 100) / 100);

	const glow = $derived(lightUp * altitudeFade);

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
	 * `CLIMB_PERIOD_SEC` is 900, and the climb curve spends ~62% of each cycle
	 * below 9,000 m — so an altitude-gated `{#if}` mounts and unmounts this
	 * source FOUR TIMES AN HOUR, every hour, forever. Each mount re-fetches and
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
	const mounted = $derived(hasRoads && lightUp > 0.01);

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
				'line-blur': 4,
				'line-opacity': 0.55 * glow
			}}
			layout={{ 'line-cap': 'round', 'line-join': 'round' }}
		/>
		<LineLayer
			id="city-roads-core"
			paint={{
				'line-color': color,
				'line-width': width,
				'line-opacity': shimmer * glow,
				// Lamps are dots, not a lit ribbon: zero-length dashes on round caps.
				// Dasharray cannot vary per feature, so the irregularity is in the
				// pattern itself: five unequal gaps that repeat, which the eye reads
				// as random spacing rather than a picket fence.
				'line-dasharray': [0, 4, 0, 6.5, 0, 3.5, 0, 8, 0, 5]
			}}
			layout={{ 'line-cap': 'round', 'line-join': 'round' }}
		/>
	</GeoJSONSource>
{/if}
