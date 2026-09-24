<script lang="ts">
	/**
	 * MiniMap — top-down inset showing the aircraft on its orbit with an elevation profile.
	 *
	 * Displays:
	 * 1. Plan View: Orbit ground track ring, forward-flying aircraft marker (▲),
	 *    and sideways passenger camera sightline to the city center.
	 * 2. Elevation View: Side-profile climb/descent cosine wave with live altitude indicator.
	 */
	import { MapLibre, RasterTileSource, RasterLayer } from 'svelte-maplibre-gl';
	import type { Map as MlMap } from 'maplibre-gl';

	import { PUBLIC_TILE_SERVER_URL } from '$app/env/public';
	import { useDisplay } from '../display.svelte.js';
	import { FlightTrack, CLIMB_PERIOD_SEC } from './flight-path.js';
	import { TILE_MAXZOOM, TILE_SIZE, tileTemplates } from '#lib/settings/tiles.js';

	const BLANK_STYLE = { version: 8 as const, sources: {}, layers: [] };

	/**
	 * Fixed zoom, chosen so the WHOLE orbit fits inside the circular crop.
	 *
	 * Measured rather than guessed: at 6.9 the projected track was 178 px wide
	 * in a 190 px circle, so its east and west ends were clipped by the border
	 * radius. 6.55 leaves a margin on the diagonal.
	 *
	 * A const, not a prop: the one caller never passed it, and a measured
	 * constant offered as configuration invites someone to change it away from
	 * the measurement.
	 */
	const zoom = 6.55;

	const display = useDisplay();
	// PUBLIC_TILE_SERVER_URL, so a pane can read tiles from a peer on the wall.
	const tiles = tileTemplates(PUBLIC_TILE_SERVER_URL);

	let map = $state<MlMap | undefined>();
	let renderTick = $state(0);

	$effect(() => {
		const m = map;
		if (!m) return;
		const onFrame = () => {
			renderTick++;
		};
		if (m.loaded()) {
			renderTick++;
		}
		m.on('load', onFrame);
		m.on('idle', onFrame);
		m.on('render', onFrame);
		m.on('move', onFrame);
		m.on('resize', onFrame);
		return () => {
			m.off('load', onFrame);
			m.off('idle', onFrame);
			m.off('render', onFrame);
			m.off('move', onFrame);
			m.off('resize', onFrame);
		};
	});

	const place = $derived(display.config.place);

	/**
	 * Ground track coordinates ring (240 samples).
	 */
	const track = $derived(
		new FlightTrack(
			place.lat,
			place.lon,
			display.config.floorM,
			display.config.ceilingM,
			display.config.direction,
			display.phase
		)
	);

	/**
	 * ONE track drives both the ring and the elevation strip.
	 */
	const ring = $derived(track.groundTrack());

	/** Live pose, straight off the view the main window just drew. */
	const lat = $derived(display.view.lat ?? place.lat);
	const lon = $derived(display.view.lon ?? place.lon);
	const heading = $derived(display.view.planeHeadingDeg);
	const aglM = $derived(display.view.aglM);
	const wallSec = $derived(display.view.wallSec);

	/** Climb bar & elevation phase (0..1). */
	const climb = $derived.by(() => {
		const lo = display.config.floorM;
		const hi = display.config.ceilingM;
		if (hi <= lo) return 0;
		return Math.min(1, Math.max(0, (aglM - lo) / (hi - lo)));
	});

	// Wall seconds, not wallSec * speed: the flown altitude keys on the wall
	// clock (view.ts), and the strip must draw the same curve the dot flies.
	const climbPhase = $derived(
		(((wallSec % CLIMB_PERIOD_SEC) + CLIMB_PERIOD_SEC) % CLIMB_PERIOD_SEC) / CLIMB_PERIOD_SEC
	);

	/**
	 * Project the aircraft marker to pixels within the circular inset.
	 */
	const marker = $derived.by(() => {
		const _ = renderTick;
		const m = map;
		if (!m) return null;
		const p = m.project([lon, lat]);
		return { x: p.x, y: p.y };
	});

	/**
	 * Project the camera's ground look-at target.
	 */
	const targetMarker = $derived.by(() => {
		const _ = renderTick;
		const m = map;
		if (!m || display.view.targetLon === undefined || display.view.targetLat === undefined)
			return null;
		const p = m.project([display.view.targetLon, display.view.targetLat]);
		return { x: p.x, y: p.y };
	});

	/**
	 * The whole ground track, projected to pixels and drawn as an SVG path.
	 */
	const pathD = $derived.by(() => {
		const _ = renderTick;
		const m = map;
		if (!m || !ring.length) return '';
		const pts = ring.map(([rLon, rLat]) => m.project([rLon, rLat]));
		if (pts.length === 0) return '';
		return `M ${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L ')} Z`;
	});

	// Elevation profile wave SVG path (sine/cosine climb waveform)
	const ELEV_WIDTH = 104;
	const ELEV_HEIGHT = 24;

	/**
	 * Dynamic elevation climb profile evaluated at the active flight phase.
	 * Evaluates track.altitudeAt across the active climb period window so the live
	 * altitude marker rides exactly on top of the SVG elevation waveform.
	 */
	const elevPathD = $derived.by(() => {
		const lo = display.config.floorM;
		const hi = display.config.ceilingM;
		const points: string[] = [];
		const periodStart = Math.floor(wallSec / CLIMB_PERIOD_SEC) * CLIMB_PERIOD_SEC;
		for (let x = 0; x <= ELEV_WIDTH; x += 2) {
			const t = periodStart + (x / ELEV_WIDTH) * CLIMB_PERIOD_SEC;
			const agl = track.altitudeAt(t);
			const normY = hi > lo ? Math.min(1, Math.max(0, (agl - lo) / (hi - lo))) : 0;
			const y = ELEV_HEIGHT - normY * (ELEV_HEIGHT - 4) - 2;
			points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
		}
		return `M ${points.join(' L ')}`;
	});

	const elevAreaD = $derived.by(() => {
		if (!elevPathD) return '';
		return `${elevPathD} L ${ELEV_WIDTH},${ELEV_HEIGHT} L 0,${ELEV_HEIGHT} Z`;
	});

	const elevDotX = $derived(climbPhase * ELEV_WIDTH);
	const elevDotY = $derived(ELEV_HEIGHT - climb * (ELEV_HEIGHT - 4) - 2);

	/**
	 * Percentage of ground visible in the window vs horizon/sky,
	 * derived from the camera's effective depression angle and airframe bank.
	 */
	const depressionDeg = $derived.by(() => {
		const pitch = display.view.cameraPitchDeg;
		return pitch !== undefined ? Math.max(1, Math.min(89, 90 - pitch)) : 18;
	});

	const groundFrac = $derived(Math.max(0.15, Math.min(1.0, depressionDeg / 40)));

	/**
	 * Dynamic FOV Ground Viewing Wedge / Frustum polygon.
	 */
	const sightlineWedgeD = $derived.by(() => {
		if (!marker || !targetMarker) return '';
		const dx = targetMarker.x - marker.x;
		const dy = targetMarker.y - marker.y;
		const dist = Math.sqrt(dx * dx + dy * dy);
		if (dist < 2) return '';

		const normX = dx / dist;
		const normY = dy / dist;
		const perpX = -normY;
		const perpY = normX;

		// Spread width responds to how much ground is framed
		const spread = Math.max(6, Math.min(26, dist * 0.3 * groundFrac));
		const p1X = (targetMarker.x + perpX * spread).toFixed(1);
		const p1Y = (targetMarker.y + perpY * spread).toFixed(1);
		const p2X = (targetMarker.x - perpX * spread).toFixed(1);
		const p2Y = (targetMarker.y - perpY * spread).toFixed(1);

		return `M ${marker.x.toFixed(1)},${marker.y.toFixed(1)} L ${p1X},${p1Y} L ${p2X},${p2Y} Z`;
	});
</script>

<div class="minimap" aria-label="Flight Orbit Minimap">
	<MapLibre
		bind:map
		autoloadGlobalCss={false}
		class="fill"
		style={BLANK_STYLE}
		center={[place.lon, place.lat]}
		{zoom}
		interactive={false}
		attributionControl={false}
	>
		<RasterTileSource
			id="mini-base"
			tiles={tiles.gibs}
			tileSize={TILE_SIZE}
			maxzoom={TILE_MAXZOOM.gibs}
		>
			<RasterLayer paint={{ 'raster-opacity': 0.6, 'raster-saturation': -0.4 }} />
		</RasterTileSource>
	</MapLibre>

	<!-- Projected SVG Ground Track & Sightline Overlay -->
	<svg class="track-svg" viewBox="0 0 190 190" aria-hidden="true">
		{#if pathD}
			<path d={pathD} class="track-path-glow" />
			<path d={pathD} class="track-path" />
		{/if}

		<!-- Sideways Passenger Window Sightline & Dynamic FOV Wedge -->
		{#if marker && targetMarker}
			{#if sightlineWedgeD}
				<path
					d={sightlineWedgeD}
					class="sightline-wedge"
					style:opacity={0.15 + 0.35 * groundFrac}
				/>
			{/if}
			<line
				x1={marker.x}
				y1={marker.y}
				x2={targetMarker.x}
				y2={targetMarker.y}
				class="sightline"
				style:opacity={0.4 + 0.6 * groundFrac}
			/>
			<circle cx={targetMarker.x} cy={targetMarker.y} r="3" class="target-dot" />
			<circle
				cx={targetMarker.x}
				cy={targetMarker.y}
				r="6"
				class="target-pulse"
				style:opacity={groundFrac}
			/>
		{/if}
	</svg>

	<!-- Aircraft Heading Marker (Aviation SVG Jet Icon) -->
	{#if marker}
		<div
			class="plane-marker"
			style:left="{marker.x}px"
			style:top="{marker.y}px"
			style:rotate="{heading}deg"
			aria-hidden="true"
		>
			<svg viewBox="0 0 24 24" width="20" height="20" class="plane-svg">
				<path
					d="M12 2 L14 9 L22 13 L22 15 L14 13 L14 19 L17 21 L17 22 L12 21 L7 22 L7 21 L10 19 L10 13 L2 15 L2 13 L10 9 Z"
					fill="#38bdf8"
					stroke="#0b111e"
					stroke-width="1"
				/>
				<circle cx="12" cy="4" r="1.5" fill="#ffffff" />
			</svg>
		</div>
	{/if}

	<!-- Reverse Direction Button -->
	<button
		type="button"
		class="reverse"
		aria-label="Reverse flight direction"
		title="Reverse flight direction"
		onclick={() => display.config.reverse()}
	>
		{display.config.direction === 1 ? '↻' : '↺'}
	</button>

	<!-- Altitude Elevation Waveform Inset (Side View) -->
	<div class="elevation-profile" title="Altitude Profile (Climb & Descent)">
		<svg width={ELEV_WIDTH} height={ELEV_HEIGHT} viewBox="0 0 {ELEV_WIDTH} {ELEV_HEIGHT}">
			<defs>
				<linearGradient id="elev-grad" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0%" stop-color="#38bdf8" stop-opacity="0.35" />
					<stop offset="100%" stop-color="#38bdf8" stop-opacity="0.02" />
				</linearGradient>
			</defs>
			<!-- Filled Altitude Envelope Area -->
			{#if elevAreaD}
				<path d={elevAreaD} fill="url(#elev-grad)" />
			{/if}
			<!-- Base Wave Curve -->
			{#if elevPathD}
				<path d={elevPathD} class="elev-wave" />
			{/if}
			<!-- Active Altitude Dot & Radar Pulse -->
			<circle cx={elevDotX} cy={elevDotY} r="2.5" class="elev-dot" />
			<circle cx={elevDotX} cy={elevDotY} r="5" class="elev-pulse" />
		</svg>
	</div>

	<!-- Telemetry Footer Readout -->
	<div class="readout">
		<span>{(aglM / 1000).toFixed(1)} km · {Math.round(heading)}° HDG</span>
	</div>
</div>

<style>
	.minimap {
		position: absolute;
		right: 1.25rem;
		/* Sit above the HUD ribbon, which is pinned to bottom: 0 and publishes its
		   measured height as --hud-height. A hard-coded offset cannot work: the
		   ribbon wraps to two or three rows as the viewport narrows, so a value
		   that clears one row overlaps at the next breakpoint — 4.75rem cleared
		   900px and 600px wide, then overlapped by 8px at 420px. */
		bottom: calc(var(--hud-height, 36px) + 0.75rem);
		width: 190px;
		height: 190px;
		border-radius: 50%;
		overflow: hidden;
		border: 1px solid rgba(255, 255, 255, 0.25);
		box-shadow:
			0 8px 28px rgba(0, 0, 0, 0.65),
			inset 0 0 0 1px var(--glass-border-subtle);
		background: #04070d;
		z-index: 30;
		user-select: none;
	}

	.track-svg {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}

	.track-path-glow {
		fill: none;
		stroke: rgba(56, 189, 248, 0.4);
		stroke-width: 4;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.track-path {
		fill: none;
		stroke: var(--accent-cyan);
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}

	.sightline {
		stroke: rgba(56, 189, 248, 0.85);
		stroke-width: 1.2;
		stroke-dasharray: 2 3;
	}

	.sightline-wedge {
		fill: rgba(56, 189, 248, 0.22);
		stroke: rgba(56, 189, 248, 0.35);
		stroke-width: 0.8;
		transition: opacity 0.2s ease;
	}

	.target-dot {
		fill: var(--accent-cyan);
		filter: drop-shadow(0 0 4px var(--accent-cyan));
	}

	.target-pulse {
		fill: none;
		stroke: rgba(56, 189, 248, 0.7);
		stroke-width: 1;
		animation: pulse-ring 2.2s cubic-bezier(0.215, 0.61, 0.355, 1) infinite;
	}

	@keyframes pulse-ring {
		0% {
			r: 3;
			opacity: 0.9;
		}
		100% {
			r: 11;
			opacity: 0;
		}
	}

	.plane-marker {
		position: absolute;
		translate: -50% -50%;
		width: 20px;
		height: 20px;
		display: flex;
		align-items: center;
		justify-content: center;
		pointer-events: none;
		filter: drop-shadow(0 0 6px rgba(0, 0, 0, 0.9)) drop-shadow(0 0 8px rgba(56, 189, 248, 0.8));
	}
	.plane-svg {
		display: block;
	}

	.reverse {
		position: absolute;
		top: 0.5rem;
		right: 0.5rem;
		width: 1.5rem;
		height: 1.5rem;
		display: grid;
		place-items: center;
		font-size: 0.85rem;
		line-height: 1;
		color: rgba(255, 255, 255, 0.9);
		background: rgba(15, 23, 42, 0.7);
		backdrop-filter: blur(4px);
		border: 1px solid rgba(255, 255, 255, 0.25);
		border-radius: 50%;
		cursor: pointer;
		z-index: 5;
		transition: all 0.15s;
	}
	.reverse:hover {
		background: rgba(56, 189, 248, 0.3);
		color: #fff;
		border-color: var(--accent-cyan);
	}

	.elevation-profile {
		position: absolute;
		/* Sits on the chord above the readout. A wider strip lower down has its
		   ends clipped by the circular border-radius. */
		bottom: 2.1rem;
		left: 50%;
		translate: -50% 0;
		pointer-events: none;
		z-index: 4;
		opacity: 0.85;
	}

	.elev-wave {
		fill: none;
		stroke: rgba(255, 255, 255, 0.35);
		stroke-width: 1.5;
		stroke-dasharray: 2 3;
	}

	.elev-dot {
		fill: var(--accent-cyan);
		stroke: #ffffff;
		stroke-width: 1;
		filter: drop-shadow(0 0 4px var(--accent-cyan));
	}

	.elev-pulse {
		fill: none;
		stroke: rgba(56, 189, 248, 0.7);
		stroke-width: 0.8;
		animation: pulse-dot 2s cubic-bezier(0.215, 0.61, 0.355, 1) infinite;
	}

	@keyframes pulse-dot {
		0% {
			r: 2.5;
			opacity: 1;
		}
		100% {
			r: 7;
			opacity: 0;
		}
	}

	.readout {
		position: absolute;
		inset: auto 0 0 0;
		padding: 0.3rem 0 0.35rem;
		text-align: center;
		font-size: 0.52rem;
		font-weight: 600;
		letter-spacing: 0.05em;
		font-variant-numeric: tabular-nums;
		color: rgba(255, 255, 255, 0.9);
		background: linear-gradient(to top, rgba(4, 7, 13, 0.85), transparent);
		pointer-events: none;
		z-index: 5;
	}

	:global(.minimap .fill) {
		position: absolute;
		inset: 0;
	}
</style>
