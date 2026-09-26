<script lang="ts">
	/**
	 * RainGlass — real water droplets on the window glass with live backdrop refraction
	 * and storm lightning flash. (No frost layer ships: an earlier docstring
	 * promised condensation frost that was never built. If frost comes back,
	 * it wants an altitude-plus-humidity gate and edge-creeping CSS like the
	 * beads — not a note in this sentence.)
	 */
	import { useDisplay } from '../display.svelte.js';
	import { strikeAt, mulberry32 } from '../flight/flight-path.js';

	const display = useDisplay();

	const active = $derived(display.weather === 'rain' || display.weather === 'storm');
	const intensity = $derived(display.weather === 'storm' ? 1 : 0.72);
	const isPerf = $derived(display.config.qualityMode === 'performance');
	const beadCount = $derived(isPerf ? 7 : 14);

	const rng = mulberry32(104729);
	function randomBetween(min: number, max: number, r: () => number): number {
		return min + r() * (max - min);
	}

	const blob = (r: () => number) => {
		const v = () => Math.round(randomBetween(38, 62, r));
		return `${v()}% ${v()}% ${v()}% ${v()}% / ${v()}% ${v()}% ${v()}% ${v()}%`;
	};

	const allBeads = Array.from({ length: 14 }, () => {
		const runner = rng() < 0.25;
		return {
			x: randomBetween(6, 94, rng),
			y: randomBetween(8, 86, rng),
			size: randomBetween(5, 14, rng),
			opacity: randomBetween(0.5, 0.85, rng),
			slide: runner ? randomBetween(40, 130, rng) : randomBetween(2, 9, rng),
			trail: runner ? randomBetween(28, 80, rng) : 0,
			dur: randomBetween(7, 15, rng),
			delay: -randomBetween(0, 12, rng),
			blur: randomBetween(0.8, 1.7, rng),
			radius: blob(rng)
		};
	});

	const beads = $derived(allBeads.slice(0, beadCount));

	/**
	 * Storm lightning, scheduled off the WALL CLOCK rather than Math.random().
	 *
	 * Each pane used to roll its own 4-13 s delay, so on a three-Pi wall the
	 * three windows flashed at three different moments. Lightning that does not
	 * agree across a continuous window reads as a fault, not as weather — the
	 * same reason the director stopped rolling its own rotation interval.
	 *
	 * Now every pane derives the same flash from the same second: the strike
	 * lands in a fixed 13 s slot, at an offset that is a pure function of the
	 * slot index. No shared state, no message, and a pane that reboots rejoins
	 * the same sequence.
	 */
	/**
	 * Read the clock the rest of the window is drawn from, rather than a second
	 * one. `display.view.wallSec` is the timestamp the current frame's pose was
	 * derived at, so the flash lands on exactly the frame it belongs to; a
	 * private `Date.now()` in a private RAF is a second clock that can sample
	 * either side of the 0.12 s strike window the pose used.
	 *
	 * Positioned, not fullscreen: the strike point comes with the schedule,
	 * so the flash blooms where the weather is instead of blinking the
	 * whole glass at once.
	 */
	const strike = $derived.by(() =>
		display.weather !== 'storm' ? null : strikeAt(display.view.wallSec)
	);
</script>

{#if active}
	<div class={['rain-glass', isPerf && 'flat']} style:--rg-intensity={intensity}>
		{#each beads as b, i (i)}
			<span
				class="bead"
				style:left="{b.x}%"
				style:top="{b.y}%"
				style:--s="{b.size}px"
				style:--o={b.opacity}
				style:--slide="{b.slide}px"
				style:--dur="{b.dur}s"
				style:--delay="{b.delay}s"
				style:--blur="{b.blur}px"
				style:--trail="{b.trail}px"
				style:border-radius={b.radius}
			></span>
		{/each}
	</div>
{/if}

{#if strike}
	<div
		class="lightning-flash"
		style:background="radial-gradient(circle at {strike.x01 * 100}% {strike.y01 * 100}%, rgba(235,
		245, 255, 0.6) 0%, rgba(235, 245, 255, 0.28) 25%, transparent 60%)"
		aria-hidden="true"
	></div>
{/if}

<style>
	.rain-glass {
		position: absolute;
		inset: 0;
		pointer-events: none;
		border-radius: inherit;
		overflow: hidden;
		z-index: 9;
		opacity: var(--rg-intensity, 0.8);
		animation: rg-fade-in 1.2s ease-out;
	}

	@keyframes rg-fade-in {
		from {
			opacity: 0;
		}
	}

	.bead {
		position: absolute;
		width: var(--s);
		height: var(--s);
		backdrop-filter: blur(var(--blur)) brightness(1.14) saturate(1.08);
		-webkit-backdrop-filter: blur(var(--blur)) brightness(1.14) saturate(1.08);
		background: linear-gradient(135deg, rgba(255, 255, 255, 0.07), rgba(255, 255, 255, 0) 60%);
		box-shadow:
			inset 1.5px 2px 3px rgba(255, 255, 255, 0.4),
			inset -2px -3px 5px rgba(0, 0, 0, 0.3),
			0 2px 4px rgba(0, 0, 0, 0.15);
		animation: rg-bead var(--dur) ease-in-out var(--delay) infinite;
	}

	.rain-glass.flat .bead {
		backdrop-filter: none;
		-webkit-backdrop-filter: none;
		background: linear-gradient(
			135deg,
			rgba(220, 235, 255, 0.22),
			rgba(180, 200, 230, 0.08) 55%,
			rgba(255, 255, 255, 0.04)
		);
	}

	.bead::after {
		content: '';
		position: absolute;
		left: 50%;
		bottom: 55%;
		width: 32%;
		height: var(--trail, 0px);
		transform: translateX(-50%);
		border-radius: 50% 50% 42% 42%;
		background: linear-gradient(
			to top,
			rgba(210, 225, 255, 0.16),
			rgba(210, 225, 255, 0.04) 55%,
			transparent
		);
		filter: blur(1.5px);
	}

	.bead::before {
		content: '';
		position: absolute;
		top: 16%;
		left: 20%;
		width: 30%;
		height: 30%;
		border-radius: 50%;
		background: radial-gradient(circle, rgba(255, 255, 255, 0.92), transparent 70%);
	}

	@keyframes rg-bead {
		0% {
			opacity: 0;
			transform: translateY(-2px) scale(0.6);
		}
		12% {
			opacity: var(--o);
			transform: translateY(0) scale(1);
		}
		68% {
			opacity: var(--o);
			transform: translateY(calc(var(--slide) * 0.12));
		}
		100% {
			opacity: 0;
			transform: translateY(var(--slide)) scale(0.96);
		}
	}

	.lightning-flash {
		position: absolute;
		inset: 0;
		pointer-events: none;
		z-index: 15;
		animation: flash 0.12s ease-out;
	}

	@keyframes flash {
		0% {
			opacity: 0;
		}
		30% {
			opacity: 1;
		}
		100% {
			opacity: 0;
		}
	}
</style>
