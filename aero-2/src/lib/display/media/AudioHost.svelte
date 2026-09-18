<script lang="ts">
	/**
	 * AudioHost — Web Audio & Playlist Audio lifecycle manager.
	 * Supports:
	 * 1. Synthetic turbofan engine rumble modulated by altitude.
	 * 2. Custom audio soundscape playlist (ambient music, boarding chimes, rain, etc.)
	 */
	import { onDestroy } from 'svelte';
	import { useDisplay } from '../display.svelte.js';
	import { AmbientAudioEngine } from './ambient-audio.js';
	import { useMediaClock } from './use-media-clock.svelte.js';

	const display = useDisplay();
	const synthAudio = new AmbientAudioEngine();

	let audioElement = $state<HTMLAudioElement | null>(null);

	/**
	 * Web Audio needs a user gesture, so this is called from any click or key.
	 *
	 * The gate is the ENGINE's own `init()` — which already no-ops once a
	 * context exists — and not a local `initialized` latch. The latch was the
	 * bug: it was set on the first gesture whatever the mode, but only called
	 * `synthAudio.init()` when the mode was already `synth`. So a kiosk that
	 * booted in `playlist`, took one click, and was later switched to `synth`
	 * had a permanently latched flag and no audio context — `setVolume` returns
	 * early on `!this.ctx`, so the result is silence, forever, with the drawer
	 * reading "synth" and nothing in the console.
	 *
	 * `?audio=playlist` is a real URL path into that state, and switching mode
	 * from the drawer is the obvious operator action, so this was reachable
	 * rather than theoretical.
	 *
	 * Calling `init()` unconditionally is the smaller fix than tracking which
	 * mode was live at gesture time: creating a suspended AudioContext costs
	 * nothing until `setVolume` resumes it, and the engine is idempotent.
	 */
	function ensureInit() {
		synthAudio.init();
		/**
		 * Also retry the ELEMENT, not just the synth engine.
		 *
		 * The effect below calls `audioElement.play()` and swallows the
		 * rejection, which is right -- a NotAllowedError before the first
		 * gesture is normal, not a fault. But nothing ever tried again: this
		 * handler only ever woke the AudioContext, and the effect re-runs on a
		 * reactive dependency change, not on a click. So a wall push that turned
		 * audio on before anyone had touched the page left the pane permanently
		 * silent until some unrelated config field happened to change.
		 *
		 * Invisible on the fielded Pis -- aero-kiosk.service passes
		 * --autoplay-policy=no-user-gesture-required -- which is exactly why it
		 * survived: it only ever bit on the admin laptop and in dev, where it
		 * reads as "the push did not work".
		 */
		if (
			audioElement &&
			audioElement.paused &&
			display.config.audioEnabled &&
			display.config.audioMode === 'playlist'
		) {
			audioElement.play().catch(() => {});
		}
	}

	/**
	 * Which track and how far in, from the wall clock. `audioTrackIndex += 1`
	 * on `onended` was a per-pane counter: three panes with three HDMI speakers
	 * in one room played three copies of the soundtrack phasing against each
	 * other, which is the failure you HEAR. See use-media-clock.svelte.ts.
	 */
	const track = useMediaClock(
		() => display.config.audioPlaylist,
		() => display.view.wallSec
	);
	const currentTrackUrl = $derived(track.url);

	$effect(() => {
		if (display.config.audioEnabled) {
			ensureInit();
		}

		if (display.config.audioMode === 'synth') {
			if (audioElement) {
				audioElement.pause();
			}
			synthAudio.setVolume(display.config.audioVolume, display.config.audioEnabled);
		} else {
			synthAudio.setVolume(0, false);
			if (audioElement && currentTrackUrl) {
				if (display.config.audioEnabled) {
					audioElement.volume = Math.max(0, Math.min(1, display.config.audioVolume));
					audioElement.play().catch(() => {});
				} else {
					audioElement.pause();
				}
			}
		}
	});

	$effect(() => {
		const agl = display.view.aglM ?? 4000;
		synthAudio.setAltitude(agl);
	});

	onDestroy(() => {
		synthAudio.destroy();
		if (audioElement) {
			audioElement.pause();
			audioElement = null;
		}
	});
</script>

<svelte:window onclick={ensureInit} onkeydown={ensureInit} />

{#if display.config.audioMode === 'playlist' && currentTrackUrl}
	{#key currentTrackUrl}
		<audio
			bind:this={audioElement}
			src={currentTrackUrl}
			loop={display.config.audioPlaylist.length <= 1}
			preload="auto"
			{@attach track.attach}
		></audio>
	{/key}
{/if}
