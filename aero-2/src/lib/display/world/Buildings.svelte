<script lang="ts">
	/**
	 * Buildings — 3D Vector Building Extrusions from OpenStreetMap GeoJSON datasets.
	 *
	 * Renders realistic city skyscrapers with height-based 3D extrusions,
	 * solar daytime architectural shading, and evening glowing window illumination.
	 */
	import { GeoJSONSource, FillExtrusionLayer, FillLayer, Image, LineLayer } from 'svelte-maplibre-gl';
	import { useDisplay } from '../display.svelte.js';
	import { quantize, slowBeat } from './beat.js';
	import { weatherLightLoss } from './atmosphere.js';

	const display = useDisplay();

	const place = $derived(display.config.place);
	const night = $derived(display.night);
	const aglM = $derived(display.view.aglM);
	const isPerf = $derived(display.config.qualityMode === 'performance');

	// Fade out buildings when climbing into the upper stratosphere (> 7,500m)
	const altitudeFade = $derived(Math.round(Math.max(0, Math.min(1, (8000 - aglM) / 2500)) * 100) / 100);

	// Dynamic building color transitioning from day concrete to night illuminated facade
	// Ramped by height, not one flat tone: low stock reads dark, towers light,
	// which is the depth cue a flat colour and 8 m median data never gave.
	const buildingColor = $derived.by(() => {
		const [lo, hi] =
			night < 0.2
				? ['#9aa0aa', '#f4f5f7'] // daylight: shadowed low stock -> lit towers
				: night < 0.6
					? ['#a86a2a', '#ffd27a'] // golden hour
					: ['#1e3a5f', '#7dd3fc']; // dusk into night
		return [
			'interpolate',
			['linear'],
			['coalesce', ['get', 'height'], 20],
			4,
			lo,
			60,
			hi
		] as never;
	});
	/**
	 * Lit windows: a 32 px tile of a dark facade with a scatter of warm dots,
	 * applied as `fill-extrusion-pattern` once it is properly night. Patterns
	 * are screen-pixel sized, so a dot stays a window at every altitude, and
	 * the pattern must be opaque where the wall is dark because pattern alpha
	 * is wall alpha. Seeded LCG, not Math.random: three panes, one facade.
	 * Plain {width,height,data} so it builds under SSR with no canvas.
	 */
	const WINDOWS_PX = 32;
	const windowsImage = (() => {
		const data = new Uint8ClampedArray(WINDOWS_PX * WINDOWS_PX * 4);
		for (let i = 0; i < data.length; i += 4) data.set([16, 18, 28, 255], i);
		let seed = 0x9e3779b9;
		const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
		for (let n = 0; n < 170; n++) {
			const x = Math.floor(rand() * WINDOWS_PX);
			const y = Math.floor(rand() * WINDOWS_PX);
			const warm = rand() < 0.8;
			const px = [warm ? 255 : 190, warm ? 196 : 214, warm ? 120 : 255, 255];
			data.set(px, (y * WINDOWS_PX + x) * 4);
			// Most windows are two pixels wide; every fourth is a lit floor, four wide.
			const run = rand() < 0.25 ? 4 : 2;
			for (let k = 1; k < run && x + k < WINDOWS_PX; k++) data.set(px, (y * WINDOWS_PX + x + k) * 4);
		}
		return { width: WINDOWS_PX, height: WINDOWS_PX, data };
	})();
	/**
	 * Two layers over one source, cross-faded on `night`: a pattern cannot be
	 * toggled (MapLibre rejects `undefined`, and a bare colour layer cannot
	 * show windows), and opacity 0 skips a fill-extrusion draw, so the day
	 * layer costs nothing at night and vice versa.
	 */
	const lit = $derived(Math.round(Math.max(0, Math.min(1, (night - 0.5) / 0.3)) * 100) / 100);
	const dayOpacity = $derived(Math.round(0.85 * altitudeFade * (1 - lit) * 100) / 100);
	// Windows flicker on their own beats, out of step with the road lamps.
	const flicker = $derived(0.8 + 0.2 * slowBeat(display.view.wallSec, 2.1, 3.3));
	// Under a cloud deck the windows dim with the roads (Roads.svelte, `deck`).
	const deck = $derived(weatherLightLoss(display.weather));
	const nightOpacity = $derived(quantize(0.95 * altitudeFade * lit * flicker * (1 - 0.8 * deck)));
	// The footprint itself glows: forecourts, car parks and lobbies light the block.
	const footprintOpacity = $derived(quantize(0.7 * altitudeFade * lit * (1 - 0.8 * deck)));
	/**
	 * Footprint outline glow: lit block edges for the pass-through.
	 *
	 * The slabs read from directly above, but on a low approach through the
	 * city the towers are dark shapes against dark ground — nothing catches
	 * the eye as the window threads between them. A LineLayer over the same
	 * polygon source strokes every footprint: from altitude the strokes merge
	 * into the lit grid, and down low each tower gets a glowing base that
	 * separates it from its neighbour. Arrives with the lit windows (same
	 * night gate) and thins with the same altitude fade, so a climbing
	 * window never leaves outlines floating over an empty grid. 0.01 steps.
	 */
	const outlineOpacity = $derived(isPerf ? 0 : quantize(lit * altitudeFade * 0.55));
</script>

<!-- Gated on the place only. Mounting on altitude re-fetched and re-parsed the
     city on the main thread four times an hour (Roads.svelte says why);
     fill-extrusion-opacity 0 skips the draw for free. -->
{#if !place.isFeature}
	<Image id="lit-windows" image={windowsImage} />
	<GeoJSONSource id="city-buildings" data="/api/buildings/{place.id}">
		<FillLayer paint={{ 'fill-color': '#f2b45c', 'fill-opacity': footprintOpacity }} />
		<FillExtrusionLayer
			layout={{
				visibility: altitudeFade > 0.005 ? 'visible' : 'none'
			}}
			paint={{
				'fill-extrusion-color': buildingColor,
				'fill-extrusion-vertical-gradient': true,
				'fill-extrusion-height': ['coalesce', ['get', 'height'], 20],
				'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
				'fill-extrusion-opacity': dayOpacity
			}}
		/>
		<FillExtrusionLayer
			paint={{
				'fill-extrusion-pattern': 'lit-windows',
				// No shading gradient at night: the lower floors are the brightest ones.
				'fill-extrusion-vertical-gradient': false,
				'fill-extrusion-height': ['coalesce', ['get', 'height'], 20],
				'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
				'fill-extrusion-opacity': nightOpacity
			}}
		/>
		<LineLayer
			id="city-buildings-outline"
			layout={{ visibility: outlineOpacity > 0.01 ? 'visible' : 'none' }}
			paint={{
				'line-color': '#ffd9a0',
				'line-width': 1,
				'line-blur': 0.5,
				'line-opacity': outlineOpacity
			}}
		/>
	</GeoJSONSource>
{/if}
