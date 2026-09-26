/**
 * useMediaClock — one playlist, driven by the wall clock, on any media element.
 *
 * Three surfaces play media in this app: the fullscreen stage (video), the
 * blind when it is down (video), and the cabin soundtrack (audio). Each used
 * to keep its own counter. This composable gives all three the same answer to
 * "which item, how far in" for the current `wallSec`, and an `attach` that
 * keeps the element there.
 *
 * Durations are learned by probing each URL's metadata once. Until every
 * duration is known the position is item 0 at `wallSec % thatItem'sDuration`
 * — the same fallback on every pane, so the wall converges as the probes land
 * instead of forking while they do. The probe is cheap because the media
 * route answers Range requests: a tail-`moov` MP4 costs two small reads, not
 * the file.
 */
import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import { decideCorrection, playlistPosition } from './media-clock.js';

export interface MediaClock {
	readonly index: number;
	readonly url: string;
	readonly offsetSec: number;
	/** `{@attach clock.attach}` on the `<video>` / `<audio>` playing `url`. */
	readonly attach: Attachment<HTMLMediaElement>;
}

/** Durations already learned, by URL. Module-wide: a URL's length does not depend on who asked. */
const knownDurations = new Map<string, number>();

function probeDuration(url: string): Promise<number> {
	return new Promise((resolve) => {
		const el = document.createElement('video');
		el.preload = 'metadata';
		el.muted = true;
		// Let go of the element once it has answered: a <video> holding a src
		// keeps a decoder and a network slot until GC, and twelve of them on a
		// Pi is a playlist that never starts.
		const done = (d: number) => {
			el.removeAttribute('src');
			el.load();
			resolve(d);
		};
		el.onloadedmetadata = () => done(el.duration);
		el.onerror = () => done(NaN);
		el.src = url;
	});
}

export function useMediaClock(urls: () => readonly string[], wallSec: () => number): MediaClock {
	// Bumped when a probe lands, so deriveds re-read the module map.
	let learned = $state(0);

	const durations = $derived.by(() => {
		void learned;
		return urls().map((u) => knownDurations.get(u) ?? NaN);
	});

	$effect(() => {
		for (const u of urls()) {
			if (knownDurations.has(u)) continue;
			// Reserve the slot so a re-run does not probe the same URL twice.
			knownDurations.set(u, NaN);
			void probeDuration(u).then((d) => {
				knownDurations.set(u, d);
				learned++;
			});
		}
	});

	const position = $derived(playlistPosition(wallSec(), durations));
	const index = $derived(position?.index ?? 0);
	const url = $derived(urls()[index] ?? '');

	/**
	 * Offset when the playlist position is unknown: the element's own length,
	 * once it has told us. Reading the element here would be a rune reading a
	 * DOM node, so the attachment feeds it back through `singleDuration`.
	 */
	let singleDuration = $state(NaN);
	const offsetSec = $derived.by(() => {
		if (position) return position.offsetSec;
		const d = singleDuration;
		if (!Number.isFinite(d) || d <= 0) return 0;
		const t = wallSec();
		return ((t % d) + d) % d;
	});

	const attach: Attachment<HTMLMediaElement> = (el) => {
		const onMeta = () => {
			singleDuration = el.duration;
			const src = untrack(() => url);
			if (src && Number.isFinite(el.duration) && el.duration > 0) {
				knownDurations.set(src, el.duration);
				learned++;
			}
			el.currentTime = untrack(() => offsetSec);
		};
		el.addEventListener('loadedmetadata', onMeta);

		/**
		 * Once a second, not once a frame: the tick is the only tracked read.
		 * `currentTime` is read untracked — a DOM property, not state.
		 */
		const tick = $derived(Math.floor(wallSec()));
		$effect(() => {
			void tick;
			untrack(() => {
				if (decideCorrection(el, offsetSec)) el.currentTime = offsetSec;
			});
		});

		return () => el.removeEventListener('loadedmetadata', onMeta);
	};

	return {
		get index() {
			return index;
		},
		get url() {
			return url;
		},
		get offsetSec() {
			return offsetSec;
		},
		attach
	};
}
