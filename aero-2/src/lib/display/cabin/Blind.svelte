<script lang="ts">
	/**
	 * Blind — the physical cabin pull-down window shade.
	 */
	import { useDisplay } from '../display.svelte.js';
	import { useBlind } from './use-blind.svelte.js';
	import BlindInfoCard from './BlindInfoCard.svelte';

	const display = useDisplay();
	const blind = useBlind(display);

	// The passenger's setting, not the effective state: the automatic hop
	// occlusion must not breathe the "drag me" handle at a wall every ten minutes.
	const showDiscoverable = $derived(!display.config.blindOpen && !blind.hasAnimated);
</script>

<div class="blind-clip" {@attach blind.attach}>
	<div
		class={['blind-overlay', showDiscoverable && 'discoverable']}
		onpointerdown={blind.onPointerDown}
		onpointermove={blind.onPointerMove}
		onpointerup={blind.onPointerUp}
		onpointercancel={blind.onPointerCancel}
		onkeydown={blind.onKeyDown}
		role="slider"
		aria-orientation="vertical"
		tabindex={0}
		aria-label="Window blind — drag to open or close"
		aria-valuenow={Math.round(Math.abs(blind.dragY))}
		aria-valuemin={0}
		aria-valuemax={105}
		style:transform={blind.transform}
		style:transition={blind.transition}
		style:pointer-events={display.blindOpen ? 'none' : 'auto'}
	>
		<div class="blind-slats"></div>
		<BlindInfoCard />
		{#if showDiscoverable}
			<div class="pull-hint" aria-hidden="true">
				<span class="chev chev-1">▼</span>
				<span class="chev chev-2">▼</span>
				<span class="chev chev-3">▼</span>
			</div>
		{/if}
	</div>

	{#if display.blindOpen}
		<div
			class="blind-grab"
			onpointerdown={blind.onPointerDown}
			onpointermove={blind.onPointerMove}
			onpointerup={blind.onPointerUp}
			onpointercancel={blind.onPointerCancel}
			role="button"
			tabindex={-1}
			aria-label="Drag down to close window blind"
		></div>
	{/if}
</div>

<style>
	.blind-clip {
		position: absolute;
		inset: var(--frame-width, 36px);
		border-radius: var(--inner-radius, 140px);
		overflow: hidden;
		z-index: 12;
		pointer-events: none;
	}

	.blind-overlay {
		position: absolute;
		inset: 0;
		border-radius: var(--inner-radius, 140px);
		background: linear-gradient(180deg, #efece6 0%, #e8e4dd 35%, #e1ddd5 65%, #d6d1c8 100%);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		border: none;
		padding: 0;
		pointer-events: auto;
		touch-action: none;
		box-shadow:
			inset 0 2px 4px rgba(255, 255, 255, 0.6),
			inset 0 -6px 12px rgba(0, 0, 0, 0.15);
	}

	.blind-slats {
		position: absolute;
		inset: 0;
		background: repeating-linear-gradient(
			180deg,
			var(--glass-border) 0px,
			var(--glass-border) 2px,
			rgba(230, 227, 221, 0.55) 2px,
			rgba(220, 217, 211, 0.55) 10px,
			rgba(0, 0, 0, 0.12) 10px,
			rgba(0, 0, 0, 0.12) 11px
		);
		mask-image: linear-gradient(
			90deg,
			rgba(0, 0, 0, 0.75) 0%,
			rgba(0, 0, 1) 20%,
			rgba(0, 0, 1) 80%,
			rgba(0, 0, 0, 0.75) 100%
		);
	}

	.blind-overlay::after {
		content: '';
		position: absolute;
		bottom: 10%;
		left: 50%;
		width: 56px;
		height: 18px;
		transform: translateX(-50%);
		background:
			repeating-linear-gradient(
				180deg,
				transparent 0px,
				transparent 3px,
				rgba(0, 0, 0, 0.22) 3px,
				rgba(0, 0, 0, 0.22) 4px
			),
			linear-gradient(180deg, #d8d4cc 0%, #a89f92 100%);
		border-radius: 9px;
		box-shadow:
			0 2px 5px rgba(0, 0, 0, 0.35),
			inset 0 1px 0 rgba(255, 255, 255, 0.6),
			inset 0 -1px 0 rgba(0, 0, 0, 0.25);
	}

	@keyframes handle-breathe {
		0%,
		100% {
			transform: translateX(-50%) translateY(0);
			opacity: 0.9;
		}
		50% {
			transform: translateX(-50%) translateY(4px);
			opacity: 1;
		}
	}

	.blind-overlay.discoverable::after {
		animation: handle-breathe 1.2s ease-in-out 3;
	}

	.pull-hint {
		position: absolute;
		bottom: 3%;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		pointer-events: none;
		opacity: 0.55;
	}

	.chev {
		font-size: 14px;
		color: rgba(0, 0, 0, 0.35);
		animation: chev-cascade 1.6s ease-in-out infinite;
	}
	.chev-1 {
		animation-delay: 0s;
	}
	.chev-2 {
		animation-delay: 0.2s;
	}
	.chev-3 {
		animation-delay: 0.4s;
	}

	@keyframes chev-cascade {
		0%,
		100% {
			opacity: 0.25;
			transform: translateY(0);
		}
		50% {
			opacity: 0.85;
			transform: translateY(3px);
		}
	}

	.blind-grab {
		position: absolute;
		inset: 0 0 auto 0;
		height: 35%;
		pointer-events: auto;
		touch-action: pan-y;
		cursor: grab;
		background: transparent;
		border: none;
		z-index: 1;
	}
	.blind-grab:active {
		cursor: grabbing;
	}
</style>
