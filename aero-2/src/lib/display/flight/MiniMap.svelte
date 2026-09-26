<script lang="ts">
	/**
	 * MiniMap — top-down inset showing the aircraft on its orbit with an elevation profile.
	 *
	 * Displays:
	 * 1. Plan View: Orbit ground track ring, forward-flying aircraft marker (▲),
	 *    and sideways passenger camera sightline to the city center.
	 * 2. Elevation View: Side-profile climb/descent cosine wave with live altitude indicator.
	 */
	import { untrack } from 'svelte';

	import { PUBLIC_TILE_SERVER_URL } from '$app/env/public';
	import { useDisplay } from '../display.svelte.js';
	import { FlightTrack, CLIMB_PERIOD_SEC } from './flight-path.js';
	import { tileTemplates } from '#lib/settings/tiles.js';
	import {
		hysteresisGate,
		NIGHT_LIGHT_RAMP,
		NIGHT_MOUNT_OFF,
		NIGHT_MOUNT_ON
	} from '../world/sun.js';
	import { Location } from '#lib/settings/locations.js';
	import {
		projectMini,
		coverTiles,
		threadArc,
		MINIMAP_SIZE_PX,
		MINIMAP_TILE_ZOOM
	} from './minimap-project.js';

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
	const templates = tileTemplates(PUBLIC_TILE_SERVER_URL);
	const gibsTemplate = templates.gibs[0];
	const viirsTemplate = templates.viirs[0];

	/**
	 * Night lights on the inset, on the main map's curve. The same
	 * NIGHT_LIGHT_RAMP the Stage uses, so the minimap's cities arrive with
	 * the main window's — two maps lighting the same night on different
	 * ramps would read as one of them lagging. Mount-gated like
	 * NightLights: by day these <img>s cost fetches for black tiles.
	 */
	const night = $derived(display.night);
	const miniNightOpacity = $derived(
		Math.min(0.8, night ** NIGHT_LIGHT_RAMP * Location.moodFor(display.config.place.id).nightGlow)
	);
	// Latched like the main-map layers: the inset blinking at twilight reads
	// as a fault on a wall of three. Tracked, not untracked — the untrack
	// froze the latch at its mount-time value (see NightLights.svelte).
	let nightLatched = $state(false);
	$effect(() => {
		nightLatched = hysteresisGate(miniNightOpacity, nightLatched, NIGHT_MOUNT_ON, NIGHT_MOUNT_OFF);
	});

	/**
	 * Live pose snapshot, refreshed at 10 Hz — NOT at frame rate.
	 *
	 * The overlay used to re-derive off the main map's `render` event, so a
	 * 240-point SVG path was re-projected and re-serialized as a string SIXTY
	 * times a second to move a marker the eye cannot see move. The aircraft
	 * crawls across a 190 px disc; 10 Hz is visually identical and drops the
	 * overlay rebuild (plus the entire second map it hung off) off the frame
	 * budget. Reads are untracked so the sampler never subscribes to the
	 * frame loop it is deliberately decoupled from.
	 */
	const SNAP_MS = 100;
	interface PoseSnap {
		lat: number;
		lon: number;
		heading: number;
		aglM: number;
		effectiveSec: number;
		targetLon: number | undefined;
		targetLat: number | undefined;
	}
	let snap = $state<PoseSnap>({
		lat: 0,
		lon: 0,
		heading: 0,
		aglM: 0,
		effectiveSec: 0,
		targetLon: undefined,
		targetLat: undefined
	});
	function samplePose(): PoseSnap {
		const place = display.config.place;
		return {
			lat: display.view.lat ?? place.lat,
			lon: display.view.lon ?? place.lon,
			heading: display.view.planeHeadingDeg,
			aglM: display.view.aglM,
			effectiveSec: display.view.wallSec * display.config.speed,
			targetLon: display.view.targetLon,
			targetLat: display.view.targetLat
		};
	}
	$effect(() => {
		snap = untrack(samplePose);
		const id = setInterval(() => {
			snap = untrack(samplePose);
		}, SNAP_MS);
		return () => clearInterval(id);
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

	/** Live pose, at the 10 Hz snapshot — see `snap` above. */
	const lat = $derived(snap.lat);
	const lon = $derived(snap.lon);
	const heading = $derived(snap.heading);
	const aglM = $derived(snap.aglM);

	/** Climb bar & elevation phase (0..1). */
	const climb = $derived.by(() => {
		const lo = display.config.floorM;
		const hi = display.config.ceilingM;
		if (hi <= lo) return 0;
		return Math.min(1, Math.max(0, (aglM - lo) / (hi - lo)));
	});

	const effectiveSec = $derived(snap.effectiveSec);
	const climbPhase = $derived(
		(((effectiveSec % CLIMB_PERIOD_SEC) + CLIMB_PERIOD_SEC) % CLIMB_PERIOD_SEC) / CLIMB_PERIOD_SEC
	);

	function tileUrl(template: string, x: number, y: number): string {
		return template
			.replace('{z}', String(MINIMAP_TILE_ZOOM))
			.replace('{x}', String(x))
			.replace('{y}', String(y));
	}

	/**
	 * The integer-zoom backdrop tiles covering the inset, with pixel
	 * placement and URLs. Recomputes only when the destination changes —
	 * plain <img>s the browser caches, no GL context, no render loop.
	 */
	const miniTiles = $derived(
		coverTiles(place.lon, place.lat, zoom).map((t) => ({
			...t,
			url: tileUrl(gibsTemplate, t.x, t.y),
			nightUrl: tileUrl(viirsTemplate, t.x, t.y)
		}))
	);

	/**
	 * Project the aircraft marker to pixels within the circular inset.
	 * Pure math now — no map instance, so no render-tick subscription and no
	 * second GL context behind a 190 px disc.
	 */
	const marker = $derived(projectMini(lon, lat, place.lon, place.lat, zoom));

	/**
	 * Project the camera's ground look-at target.
	 */
	const targetMarker = $derived.by(() => {
		if (snap.targetLon === undefined || snap.targetLat === undefined) return null;
		return projectMini(snap.targetLon, snap.targetLat, place.lon, place.lat, zoom);
	});

	/**
	 * The whole ground track, projected to pixels and drawn as an SVG path.
	 * No render-tick dependency anymore: the ring only changes with the
	 * destination, so this builds once per place instead of sixty times
	 * a second.
	 */
	const pathD = $derived.by(() => {
		if (!ring.length) return '';
		const pts = ring.map(([rLon, rLat]) => projectMini(rLon, rLat, place.lon, place.lat, zoom));
		if (pts.length === 0) return '';
		return `M ${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L ')} Z`;
	});

	/**
	 * Downtown thread, drawn so the marker rides ON a path mid-pass.
	 * Null when the gate never opens (features, high floors) — draw nothing.
	 * Same pure inputs as minimap-project.threadArc, so the arc is
	 * identical every visit and needs no live subscription.
	 */
	const threadD = $derived.by(() => {
		const arc = threadArc(track, place.lat, place.lon, display.config.floorM, display.config.speed);
		if (!arc) return '';
		const pts = arc.map(([aLon, aLat]) => projectMini(aLon, aLat, place.lon, place.lat, zoom));
		return `M ${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' L ')}`;
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
		const periodStart = Math.floor(effectiveSec / CLIMB_PERIOD_SEC) * CLIMB_PERIOD_SEC;
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
	<!-- Backdrop WITHOUT a second live map: a handful of static tiles placed
	     by the same mercator math as the SVG overlay, fetched once per
	     destination and cached by the browser. The old MapLibre instance
	     owned a full WebGL context and repainted at frame rate for a 190 px
	     inset — this is plain <img>s over a dark disc, at zero frame cost. -->
	<div class="tile-bed" aria-hidden="true">
		{#each miniTiles as t (t.url)}
			<img
				src={t.url}
				alt=""
				loading="lazy"
				draggable="false"
				style:left="{t.left}px"
				style:top="{t.top}px"
				style:width="{t.size}px"
				style:height="{t.size}px"
			/>
		{/each}
	</div>
	{#if nightLatched}
		<!-- Emitted light, like the main map: screen-blended so the dark
		     frame changes nothing and lit cities read as towns. -->
		<div class="tile-night" aria-hidden="true" style:opacity={miniNightOpacity}>
			{#each miniTiles as t (t.nightUrl)}
				<img
					src={t.nightUrl}
					alt=""
					loading="lazy"
					draggable="false"
					style:left="{t.left}px"
					style:top="{t.top}px"
					style:width="{t.size}px"
					style:height="{t.size}px"
				/>
			{/each}
		</div>
	{/if}

	<!-- Projected SVG Ground Track & Sightline Overlay -->
	<svg class="track-svg" viewBox="0 0 {MINIMAP_SIZE_PX} {MINIMAP_SIZE_PX}" aria-hidden="true">
		{#if pathD}
			<path d={pathD} class="track-path-glow" />
			<path d={pathD} class="track-path" />
		{/if}
		{#if threadD}
			<path d={threadD} class="thread-path" />
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

	.tile-bed {
		position: absolute;
		inset: 0;
		overflow: hidden;
		background: #04070d;
		/* The live map graded its raster dimmer and cooler; keep the look. */
		filter: opacity(0.6) saturate(0.6);
		pointer-events: none;
	}
	.tile-bed img {
		position: absolute;
		max-width: none;
	}
	.tile-night {
		position: absolute;
		inset: 0;
		overflow: hidden;
		mix-blend-mode: screen;
		pointer-events: none;
	}
	.tile-night img {
		position: absolute;
		max-width: none;
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

	.thread-path {
		fill: none;
		stroke: var(--accent-cyan);
		stroke-width: 1.4;
		stroke-dasharray: 3 2;
		stroke-linecap: round;
		opacity: 0.85;
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
