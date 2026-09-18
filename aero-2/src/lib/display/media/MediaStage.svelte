<script lang="ts">
	/**
	 * MediaStage — fullscreen video or photo slideshow for the non-flight modes.
	 *
	 * Everything on it is a function of the wall clock: which slide, which
	 * clip, and how far into the clip. See `use-media-clock.svelte.ts` for the
	 * video half and the docstring on `slideIndex` for the still half.
	 *
	 * Exit: a long press on the stage (ported from aero-1: 1.2 s, 16 px move
	 * tolerance), or Escape where there is a keyboard. It used to be a bare
	 * click, which on a wall at shoulder height means anyone brushing past it.
	 *
	 * The exit is LOCAL — this pane only. A follower cannot POST /api/wall
	 * without the admin token, so the honest scope is the same as aero-1's
	 * long-press: this screen returns to flight, the other two keep playing
	 * until the next push. The desync signal in the fleet rollup is what makes
	 * that visible to an operator rather than a surprise.
	 */
	import { useDisplay } from '../display.svelte.js';
	import { useMediaClock } from './use-media-clock.svelte.js';

	const display = useDisplay();

	let failedUrls = $state<string[]>([]);
	let mediaError = $state(false);

	const mode = $derived(display.config.displayMode);

	const videoList = $derived(
		display.config.videoPlaylist.length > 0
			? display.config.videoPlaylist
			: display.config.videoUrl
				? [display.config.videoUrl]
				: []
	);
	const video = useMediaClock(
		() => videoList,
		() => display.view.wallSec
	);

	// Image slideshow calculation
	const urls = $derived(display.config.screensaverUrls);
	const playableImages = $derived(urls.filter((u) => !failedUrls.includes(u)));
	/**
	 * Which slide, derived from the wall clock rather than counted.
	 *
	 * `(slideIndex + 1) % n` on a private 10 s interval is a per-process
	 * sequence: three Pis boot seconds apart, so three panes of one screensaver
	 * sat on three different photographs and stayed that way. The index is a
	 * pure function of the second instead -- same rule the director already
	 * follows for the destination, and a pane that reboots rejoins mid-show
	 * instead of restarting the sequence.
	 *
	 * `display.view.wallSec` keeps ticking here: Display.svelte mounts the world
	 * unconditionally and MediaStage draws over it, so the frame loop is live
	 * even when nothing of the flight is visible.
	 */
	const SLIDE_SEC = 10;
	const slideIndex = $derived(
		playableImages.length === 0
			? 0
			: Math.floor(display.view.wallSec / SLIDE_SEC) % playableImages.length
	);

	const currentImageUrl = $derived(playableImages.length > 0 ? playableImages[slideIndex] : '');

	/**
	 * After total media failure, return to flight so the wall is not stuck on
	 * a black screen reading "Media failed to load" until someone drives to
	 * the site. Same 4 s aero-1 uses: long enough to read, short enough that a
	 * bad URL costs the room a blink rather than an evening.
	 */
	const AUTO_FLIGHT_AFTER_MS = 4000;
	let autoFlightTimer: ReturnType<typeof setTimeout> | null = null;

	function returnToFlight() {
		display.config.displayMode = 'flight';
	}

	function markFailed(url: string) {
		if (!url || failedUrls.includes(url)) return;
		failedUrls = [...failedUrls, url];
		if (mode === 'video' || urls.filter((u) => !failedUrls.includes(u)).length === 0) {
			mediaError = true;
			if (autoFlightTimer) clearTimeout(autoFlightTimer);
			autoFlightTimer = setTimeout(returnToFlight, AUTO_FLIGHT_AFTER_MS);
		}
	}

	const LONG_PRESS_MS = 1200;
	const LONG_PRESS_MOVE_PX = 16;
	let pressTimer: ReturnType<typeof setTimeout> | null = null;
	let pressX = 0;
	let pressY = 0;

	function clearPress() {
		if (pressTimer) clearTimeout(pressTimer);
		pressTimer = null;
	}
	function onPointerDown(e: PointerEvent) {
		pressX = e.clientX;
		pressY = e.clientY;
		clearPress();
		pressTimer = setTimeout(() => {
			pressTimer = null;
			returnToFlight();
		}, LONG_PRESS_MS);
	}
	function onPointerMove(e: PointerEvent) {
		if (pressTimer && Math.hypot(e.clientX - pressX, e.clientY - pressY) > LONG_PRESS_MOVE_PX) {
			clearPress();
		}
	}

	$effect(() => () => {
		clearPress();
		if (autoFlightTimer) clearTimeout(autoFlightTimer);
	});
</script>

{#if mode !== 'flight'}
	<div
		class="media-stage"
		role="img"
		aria-label="Media Stage — hold to return to flight"
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={clearPress}
		onpointercancel={clearPress}
		onpointerleave={clearPress}
	>
		{#if mode === 'standby'}
			<div class="standby-screen">
				<span class="standby-hint">Hold the screen or press Escape to wake</span>
			</div>
		{:else if mediaError}
			<div class="empty">
				Media failed to load
				<span class="hint">Returning to flight…</span>
			</div>
		{:else if mode === 'video' && video.url}
			{#key video.url}
				<video
					class="media"
					src={video.url}
					autoplay
					muted
					loop={videoList.length <= 1}
					playsinline
					onerror={() => markFailed(video.url)}
					{@attach video.attach}
				></video>
			{/key}
		{:else if mode === 'screensaver' && currentImageUrl}
			{#key currentImageUrl}
				<img
					class="media"
					src={currentImageUrl}
					alt=""
					onerror={() => markFailed(currentImageUrl)}
				/>
			{/key}
		{:else}
			<div class="empty">
				No media specified
				<span class="hint">Hold the screen to return to flight</span>
			</div>
		{/if}
	</div>
{/if}

<style>
	.media-stage {
		position: absolute;
		inset: 0;
		background: #000;
		display: grid;
		place-items: center;
		overflow: hidden;
		z-index: 25;
		touch-action: none;
	}
	.media {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
		pointer-events: none;
	}
	img.media {
		animation: fade-in 0.6s ease;
	}
	@keyframes fade-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	.empty,
	.standby-screen {
		color: rgba(255, 255, 255, 0.55);
		font-size: 0.85rem;
		text-align: center;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.hint,
	.standby-hint {
		font-size: 0.7rem;
		opacity: 0.65;
	}
</style>
