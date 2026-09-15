<script lang="ts">
	/**
	 * GlassClock — glassmorphic wall clock, toggled by a tap on the open glass.
	 *
	 * aero-1 parity (`CabinClock.svelte`): one small element, live-scene
	 * refraction via `backdrop-filter`, mounted only while visible so a
	 * hidden clock costs nothing — no blur pass, no timer. The 1 s interval
	 * starts on mount and is released on unmount for the same reason.
	 *
	 * Real local time (a wall clock), not sim `timeOfDay`: a passenger
	 * checking the time wants to know when their meeting starts. Minutes
	 * go through the shared `formatClock` floor convention so this can
	 * never disagree with the Hud's clock about what minute it is.
	 */
	import { formatClock, formatUtcOffset } from '#lib/format.js';

	let now = $state(new Date());

	$effect(() => {
		const id = setInterval(() => {
			now = new Date();
		}, 1000);
		return () => clearInterval(id);
	});

	const time = $derived(formatClock(now.getHours() + now.getMinutes() / 60));
	const seconds = $derived(now.getSeconds().toString().padStart(2, '0'));
	const date = $derived(
		now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
	);
	// Device-local UTC offset, so a traveller reading the clock knows WHICH
	// midnight this is. Derived from the Date, never typed in — the locations
	// module learned that hand-typed offsets drift.
	const zone = $derived(formatUtcOffset(-now.getTimezoneOffset() / 60));
</script>

<div class="glass-clock" role="status" aria-live="polite" aria-label="Current time {time} {zone}">
	<span class="time">{time}<span class="secs">:{seconds}</span></span>
	<span class="date">{date} · {zone}</span>
</div>

<style>
	/* Invisible clock: no card, no panel, no border — just glass numerals
	   floating over the scene. Legibility comes from the glyphs themselves
	   (gradient + drop shadow), not a box behind them. */
	.glass-clock {
		position: absolute;
		top: 6%;
		left: 50%;
		transform: translateX(-50%);
		z-index: 14;

		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;

		background: none;
		border: none;
		box-shadow: none;
		pointer-events: none;
	}
	/* Glass numerals: the digits themselves are frosted glass, not paint.
	   Translucent gradient clipped to the glyphs over the card's blur pass,
	   with a faint top-light and soft shadow for legibility against bright
	   cloud. Nothing else on the card changes — it stays minimal. */
	.time {
		font-size: 2.75rem;
		font-weight: 700;
		letter-spacing: 0.04em;
		font-variant-numeric: tabular-nums;
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
		/* No card behind the glyphs anymore, so the shadow works harder:
		   tight dark core for bright cloud, soft halo for dark sky. */
		filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.8)) drop-shadow(0 2px 12px rgba(0, 0, 0, 0.45));
	}
	.date {
		font-size: 0.8rem;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: rgba(255, 255, 255, 0.75);
	}
	.secs {
		font-size: 1.1rem;
		font-weight: 600;
		letter-spacing: 0.02em;
	}
</style>
