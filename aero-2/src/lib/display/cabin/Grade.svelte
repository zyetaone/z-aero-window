<script lang="ts">
	/**
	 * Grade — one-element finishing wash over the 3D world.
	 *
	 * Mounted after the Stage boundary and before the Wing: the world gets
	 * graded, the cabin chrome (wing, frame, blind, HUD) does not — glass
	 * and airframe have their own lighting and must not be tinted twice.
	 * The wing already ramps its key light off `night`; this warms and
	 * cools the world beneath it on the same ramps.
	 *
	 * One static element, two alpha washes, no animation: opacity changes
	 * arrive at sky timescales (minutes), so there is nothing to animate
	 * and no per-frame cost beyond compositing two fullscreen gradients.
	 */
	import { useDisplay } from '../display.svelte.js';
	import { gradeWash } from './grade.js';

	const display = useDisplay();

	const night = $derived(display.night);
	const sunElevation = $derived(display.sun.elevationDeg);
	const wash = $derived(gradeWash(night, sunElevation));
	/**
	 * Flight mode only: pushed media (video, slideshow) shows as authored.
	 * A night cool-wash over an admin video is not atmosphere, it is a bug
	 * tinting somebody else's content — same rule as MediaStage, mirrored.
	 */
	const mounted = $derived(
		display.config.displayMode === 'flight' && (wash.warm > 0.001 || wash.cool > 0.001)
	);
</script>

{#if mounted}
	<div
		class="aero-grade"
		style:background="linear-gradient(rgba(255, 150, 60, {wash.warm}), rgba(255, 150, 60, {wash.warm})), linear-gradient(rgba(90, 130, 200, {wash.cool}), rgba(90, 130, 200, {wash.cool}))"
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
