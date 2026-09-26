<script module lang="ts">
	/** Auto-dismiss, so the window is never left wearing a dashboard. */
	export const CARD_TIMEOUT_MS = 12_000;
</script>

<script lang="ts">
	/**
	 * DestinationCard — what a curious visitor gets for a deliberate double-tap.
	 *
	 * Where the plane is, the destination's local time, the room's time, and
	 * the weather with its source named. Mounted only while shown, so an
	 * unrevealed card costs nothing; it dismisses on a second double-tap or
	 * on its own after `CARD_TIMEOUT_MS`, so the window is never left wearing
	 * a dashboard. The timeout is pane-local UI chrome, not world state — the
	 * scene behind it is untouched (ADR-007's carve-out for chrome).
	 *
	 * Destination time comes from the flown pose (`view.timeOfDay`), the same
	 * number the sun is computed from, so the card can never disagree with the
	 * sky about whether it is evening. Weather is labelled honestly: the
	 * scheduled deck is a schedule, not a forecast, until a live feed exists.
	 */
	import { onMount } from 'svelte';
	import { useDisplay } from '../display.svelte.js';
	import { formatClock, formatUtcOffset } from '#lib/format.js';


	const { ondismiss }: { ondismiss: () => void } = $props();
	const display = useDisplay();

	onMount(() => {
		const id = setTimeout(ondismiss, CARD_TIMEOUT_MS);
		return () => clearTimeout(id);
	});

	let now = $state(new Date());
	$effect(() => {
		const id = setInterval(() => (now = new Date()), 1000);
		return () => clearInterval(id);
	});

	const place = $derived(display.config.place);
	const thereTime = $derived(formatClock(display.view.timeOfDay));
	// Same composition as the clock beside it: `view.timeOfDay` is
	// `place.utcOffset + clockOffsetH`, so the zone label folds the preset offset
	// in too. Hud.svelte documents the mismatch this avoids ("21:00 UTC-6" for a
	// moment that is not 21:00 in UTC-6).
	const thereZone = $derived(formatUtcOffset(place.utcOffset + display.config.clockOffsetH));
	const hereTime = $derived(formatClock(now.getHours() + now.getMinutes() / 60));
	const hereZone = $derived(formatUtcOffset(-now.getTimezoneOffset() / 60));
	const altitudeM = $derived(Math.round(display.view.aglM / 100) * 100);
	// `weatherAt` uses the operator's value when it is not 'clear' or when live
	// following is off; otherwise the wall-clock schedule. Say which.
	const pinned = $derived(display.config.weather !== 'clear' || !display.config.liveWeather);
	const weatherLabel = $derived(pinned ? 'set by the operator' : 'scheduled, not a forecast');
</script>

<div class="card" role="status" aria-live="polite">
	<span class="place">{place.name}</span>
	<span class="line"
		><span class="k">Local time</span> {thereTime} <span class="z">{thereZone}</span></span
	>
	<span class="line"><span class="k">Here</span> {hereTime} <span class="z">{hereZone}</span></span>
	<span class="line"
		><span class="k">Weather</span> {display.weather} <span class="z">{weatherLabel}</span></span
	>
	<span class="line"><span class="k">Altitude</span> {altitudeM.toLocaleString()} m above ground</span>
</div>

<style>
	/* Glass numerals over the scene, no panel: the same treatment as the
	   Hud's clock, so the card reads as etched on the window, not stuck on. */
	.card {
		position: absolute;
		top: 6%;
		left: 50%;
		transform: translateX(-50%);
		z-index: 14;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		pointer-events: none;
		color: rgba(255, 255, 255, 0.85);
		text-shadow:
			0 1px 2px rgba(0, 0, 0, 0.8),
			0 2px 12px rgba(0, 0, 0, 0.45);
		font-variant-numeric: tabular-nums;
	}
	.place {
		font-size: 2.4rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: transparent;
		background: linear-gradient(
			180deg,
			rgba(255, 255, 255, 0.85) 0%,
			rgba(255, 255, 255, 0.42) 48%,
			rgba(190, 220, 245, 0.52) 52%,
			rgba(255, 255, 255, 0.72) 100%
		);
		-webkit-background-clip: text;
		background-clip: text;
		filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.8)) drop-shadow(0 2px 12px rgba(0, 0, 0, 0.45));
	}
	.line {
		font-size: 0.95rem;
		letter-spacing: 0.06em;
	}
	.k {
		text-transform: uppercase;
		font-size: 0.7rem;
		letter-spacing: 0.14em;
		opacity: 0.7;
		margin-right: 0.4em;
	}
	.z {
		opacity: 0.65;
		font-size: 0.8rem;
	}
</style>
