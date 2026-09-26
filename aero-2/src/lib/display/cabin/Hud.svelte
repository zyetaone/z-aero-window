<script lang="ts">
	/**
	 * Hud — Real-time telemetry, live FPS monitor, flight instruments, and attribution status band.
	 * Rendered as a single sleek, continuous glassmorphism ribbon across the bottom edge.
	 */
	import { useDisplay } from '../display.svelte.js';
	import { TILE_ATTRIBUTION } from '#lib/settings/tiles.js';
	import { formatClock, formatUtcOffset } from '#lib/format.js';

	interface Props {
		visible?: boolean;
	}

	let { visible = true }: Props = $props();

	const display = useDisplay();

	// Live FPS Counter state (driven from main simulation tick — zero extra RAF loops)
	const fps = $derived(display.fps);
	const frameTimeMs = $derived(display.frameTimeMs);

	/**
	 * The ribbon's real rendered height, republished as `--hud-height`.
	 *
	 * The contents wrap to two or three rows as the viewport narrows, so its
	 * height is not a constant. Anything stacked above it must clear the ACTUAL
	 * height; a hard-coded offset that clears one row overlaps at the next
	 * breakpoint, which is what the minimap did at 420 px wide.
	 */
	let ribbonHeight = $state(36);
	$effect(() => {
		if (typeof document === 'undefined') return;
		document.documentElement.style.setProperty('--hud-height', `${visible ? ribbonHeight : 0}px`);
	});

	/** 17.4435, 78.3772 -> "17.44N 78.38E". Signed degrees read as data; a
	 *  hemisphere letter reads as a position, which is what a window shows. */
	function formatCoord(lat: number, lon: number): string {
		const ns = lat >= 0 ? 'N' : 'S';
		const ew = lon >= 0 ? 'E' : 'W';
		return `${Math.abs(lat).toFixed(2)}${ns} ${Math.abs(lon).toFixed(2)}${ew}`;
	}

	const placeName = $derived(display.config.place.name);
	const coords = $derived(formatCoord(display.view.lat, display.view.lon));
	const aglM = $derived(Math.round(display.view.aglM));
	const aglFt = $derived(Math.round(aglM * 3.28084));
	const gndM = $derived(
		display.view.groundM === undefined ? null : Math.round(display.view.groundM)
	);
	const heading = $derived(Math.round(display.view.planeHeadingDeg));
	const bank = $derived(display.view.bankDeg.toFixed(1));
	const localTime = $derived(formatClock(display.view.timeOfDay ?? 12));
	/**
	 * The zone label must include `clockOffsetH`, because the CLOCK beside it
	 * already does.
	 *
	 * `timeOfDay` is derived from `place.utcOffset + clockOffsetH`, so with a
	 * tuning offset dialled in the HUD read a shifted time next to the
	 * destination's real zone — "21:00 UTC-6" for a moment that is not 21:00 in
	 * UTC-6. Two halves of one readout disagreeing is the sort of thing that
	 * gets believed, since neither half looks wrong on its own.
	 *
	 * The operator drawer already got this right (`clockLabel` appends the
	 * offset); this is the passenger-facing copy of the same readout.
	 */
	const utcLabel = $derived(
		formatUtcOffset(display.config.place.utcOffset + display.config.clockOffsetH)
	);
	const sunElev = $derived(display.sun.elevationDeg);
	const solarPhase = $derived.by(() => {
		if (sunElev > 15) return '☀️ DAY';
		if (sunElev > 0) return '🌅 DUSK';
		if (sunElev > -12) return '🌌 TWILIGHT';
		return '🌙 NIGHT';
	});
	const band = $derived(display.atmosphere.bandId);
</script>

{#if visible}
	<!--
		Publishes its own height as `--hud-height` on the document root, so
		anything stacked above it (the minimap) clears the ACTUAL ribbon rather
		than a hard-coded guess.
	-->
	<aside
		class="hud-ribbon-bar"
		bind:clientHeight={ribbonHeight}
		aria-label="Flight Telemetry Ribbon"
	>
		<!-- Telemetry Sections -->
		<div class="ribbon-content">
			<div class="hud-segment fps-segment" class:drop={fps < 45}>
				<span class="status-dot"></span>
				<span class="fps-val">{fps} FPS</span>
				<span class="ms-val">{frameTimeMs}ms</span>
			</div>
			<div class="divider"></div>

			<div class="hud-segment">
				<span class="seg-label">LOC</span>
				<strong class="seg-val">{placeName}</strong>
				<span class="seg-sub">{coords}</span>
			</div>

			<div class="divider"></div>

			<div class="hud-segment">
				<span class="seg-label">ALT</span>
				<strong class="seg-val">{aglM} m</strong>
				<span class="seg-sub"
					>({aglFt.toLocaleString()} ft{#if gndM !== null}
						· GND {gndM.toLocaleString()} m{/if})</span
				>
			</div>

			<div class="divider"></div>

			<div class="hud-segment">
				<span class="seg-label">HDG</span>
				<strong class="seg-val">{heading}°</strong>
			</div>

			<div class="divider"></div>

			<div class="hud-segment">
				<span class="seg-label">BANK</span>
				<strong class="seg-val">{bank}°</strong>
			</div>

			<div class="divider"></div>

			<div class="hud-segment">
				<span class="seg-label">TIME</span>
				<strong class="seg-val">{localTime} <span class="tz-chip">{utcLabel}</span></strong>
				<span class="seg-sub">{solarPhase} ({sunElev > 0 ? '+' : ''}{sunElev.toFixed(0)}°)</span>
			</div>

			<div class="divider"></div>

			<div class="hud-segment">
				<span class="seg-label">BAND</span>
				<strong class="seg-val band-val">{band}</strong>
			</div>
		</div>

		<!-- Single Attribution Segment -->
		<div class="attribution-section" title={TILE_ATTRIBUTION}>
			<span class="attr-text">{TILE_ATTRIBUTION}</span>
		</div>
	</aside>
{/if}

<style>
	.hud-ribbon-bar {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		min-height: 36px;
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0 16px;
		background: rgba(15, 23, 42, 0.82);
		backdrop-filter: blur(14px);
		-webkit-backdrop-filter: blur(14px);
		border-top: 1px solid var(--glass-border);
		z-index: 20;
		user-select: none;
		font-family: var(--font-sans);
		font-size: 0.72rem;
		box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.4);
	}

	.ribbon-content {
		display: flex;
		align-items: center;
		gap: 12px;
		height: 100%;
	}

	.hud-segment {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--text-primary);
		white-space: nowrap;
	}

	.divider {
		width: 1px;
		height: 14px;
		background: rgba(255, 255, 255, 0.15);
	}

	.status-dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: #4ade80;
		box-shadow: 0 0 6px #4ade80;
	}

	.fps-segment.drop .status-dot {
		background: #f87171;
		box-shadow: 0 0 6px #f87171;
	}

	.fps-val {
		color: #4ade80;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
	}

	.fps-segment.drop .fps-val {
		color: #f87171;
	}

	.ms-val {
		color: var(--text-muted);
		font-size: 0.65rem;
	}

	.seg-label {
		color: var(--accent-cyan);
		font-size: 0.62rem;
		font-weight: 700;
		letter-spacing: 0.05em;
	}

	.seg-val {
		color: var(--text-primary);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.tz-chip {
		font-size: 0.58rem;
		font-weight: 600;
		padding: 1px 4px;
		border-radius: 4px;
		background: rgba(56, 189, 248, 0.15);
		color: var(--accent-cyan);
		border: 1px solid rgba(56, 189, 248, 0.25);
		margin-left: 2px;
	}

	.band-val {
		color: var(--accent-cyan);
		text-transform: uppercase;
		font-size: 0.68rem;
		letter-spacing: 0.03em;
	}

	.seg-sub {
		color: var(--text-muted);
		font-size: 0.65rem;
	}

	.attribution-section {
		display: flex;
		align-items: center;
		color: var(--text-muted);
		font-size: 0.65rem;
		letter-spacing: 0.02em;
		opacity: 0.85;
		white-space: nowrap;
	}

	.attribution-section:hover {
		opacity: 1;
		color: var(--text-primary);
	}

	@media (max-width: 900px) {
		.hud-ribbon-bar {
			height: auto;
			padding: 6px 12px;
			flex-direction: column;
			gap: 4px;
			align-items: flex-start;
		}
		.ribbon-content {
			flex-wrap: wrap;
			gap: 8px;
		}
		.divider {
			display: none;
		}
	}
</style>
