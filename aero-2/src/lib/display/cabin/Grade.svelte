<script lang="ts">
	/**
	 * Grade — one-element finishing wash over the 3D world.
	 *
	 * Mounted after the Stage boundary and before the Wing: the world gets
	 * graded, the cabin chrome (wing, frame, blind, HUD) does not — glass
	 * and airframe have their own lighting and must not be tinted twice.
	 * The wing already ramps its key light off `night`; this warms the world
	 * beneath it on the same ramp.
	 *
	 * One static element, one alpha wash, no animation: the value arrives at
	 * sky timescales (minutes), so there is nothing to animate and no
	 * per-frame cost beyond compositing one fullscreen gradient.
	 */
	import { useDisplay } from '../display.svelte.js';
	import { gradeWarm } from './grade.js';

	const display = useDisplay();

	const sunElevation = $derived(display.sun.elevationDeg);
	const warm = $derived(gradeWarm(display.night, sunElevation));
	/**
	 * Flight mode only: pushed media (video, slideshow) shows as authored.
	 * A dusk wash over an admin video is not atmosphere, it is a bug tinting
	 * somebody else's content — same rule as MediaStage, mirrored.
	 */
	const mounted = $derived(display.config.displayMode === 'flight' && warm > 0.001);
</script>

{#if mounted}
	<div
		class="aero-grade"
		style:background="linear-gradient(rgba(255, 150, 60, {warm}), rgba(255, 150, 60, {warm}))"
		aria-hidden="true"
	></div>
{/if}

<style>
	.aero-grade {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}
</style>
