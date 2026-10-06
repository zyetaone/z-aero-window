/**
 * What the panes play (Slice 4): an audio playlist over the flight, a muted clip
 * over the glass. Both resolve IDs against the wall origin (ops/media.ts): the
 * file lives on the uploader, never on every pane.
 *
 * Audio is centre/solo only (main.ts gates it like the cabin drone): three panes
 * of the same track drift into an echo. Video is muted everywhere, so a video
 * wall stays one image, not three soundtracks. A missing file skips (audio) or
 * hides (video): a re-uploaded store must never black the window.
 */
import { mediaUrl } from '#ops/media.ts';

/** Loop IDs in order, skipping files that fail to load. Off kiosk, the first tap starts it. */
export function playAudioPlaylist(ids: string[], origin: string) {
	if (!ids.length) return;
	const el = document.createElement('audio');
	el.volume = 0.8;
	let i = 0;
	const load = () => {
		el.src = mediaUrl(origin, ids[i]!);
		el.play().catch(() => addEventListener('pointerdown', () => el.play().catch(() => {}), { once: true }));
	};
	el.addEventListener('ended', () => {
		i = (i + 1) % ids.length;
		load();
	});
	let misses = 0;
	el.addEventListener('playing', () => (misses = 0));
	el.addEventListener('error', () => {
		// A store ID with no file behind it: skip, not silence. Nothing playable: stop.
		if (++misses >= ids.length) return void el.remove();
		i = (i + 1) % ids.length;
		load();
	});
	load();
}

/** One muted clip looped over the glass, under the blind (index.html z-order). */
export function showVideo(id: string, origin: string) {
	const el = document.createElement('video');
	el.src = mediaUrl(origin, id);
	el.muted = true;
	el.loop = true;
	el.playsInline = true;
	Object.assign(el.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', objectFit: 'cover', zIndex: '2' });
	el.addEventListener('error', () => el.remove()); // no file, no element: the flight shows through
	document.body.append(el);
	el.play().catch(() => {});
}
