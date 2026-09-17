/**
 * media-store — where uploaded songs and clips live on a Pi.
 *
 * Content-addressed: SHA-256 of the bytes, first 16 hex, plus the original
 * extension. Same file uploaded twice is the same path, so a re-upload costs
 * nothing and a URL can be cached forever. That is not a tidiness win — it is
 * what makes `Cache-Control: immutable` honest, which matters when three panes
 * fetch the same 40 MB clip off one Pi.
 *
 * Stored under `data/media/`, NOT `static/media/`, for the reason `tiles.ts`
 * already records: `static/` is copied into the build by the adapter, so a file
 * written there at runtime is never served. Anything uploaded after build time
 * has to be served by a route.
 *
 * This module holds no gate of its own. The ROUTES are bearer-gated; putting a
 * second check here would be a rule in two places that can disagree — the same
 * argument `aero-1/src/lib/server/bundle/assets.ts` makes, and the one this is
 * ported from.
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';

/**
 * Audio and video only. Not images: nothing in the cabin renders one, and an
 * allowlist that grants more than the app can use is an upload surface with no
 * reader. Extend it when something needs the format, not before.
 */
const MIME_BY_EXT: Record<string, string> = {
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.mp3': 'audio/mpeg',
	'.m4a': 'audio/mp4',
	'.ogg': 'audio/ogg',
	'.opus': 'audio/ogg',
	'.wav': 'audio/wav',
	'.flac': 'audio/flac'
};

/** Which of those the cabin plays through `<audio>` rather than `<video>`. */
const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.ogg', '.opus', '.wav', '.flac']);

export type MediaKind = 'audio' | 'video';

/**
 * Per-upload size cap, MB. A calibration knob, not a derivation: a Pi's disk
 * and a venue's clips are both facts this module cannot see. 50 MB matches
 * aero-1's default; raise it with `AERO_MEDIA_MAX_MB` rather than editing here.
 */
export function maxUploadBytes(env: NodeJS.ProcessEnv = process.env): number {
	const mb = Number(env.AERO_MEDIA_MAX_MB);
	return (Number.isFinite(mb) && mb > 0 ? mb : 50) * 1024 * 1024;
}

export function mediaDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.AERO_MEDIA_DIR ?? resolve(process.cwd(), 'data/media');
}

/**
 * The only shape a stored name may take, and the reason path traversal cannot
 * reach this module: names are GENERATED from a hash, never taken from the
 * uploader. A request for anything else is not a miss, it is a probe.
 */
export const STORED_NAME = /^[0-9a-f]{16}\.[a-z0-9]{2,5}$/;

export function isAllowedExtension(filename: string): boolean {
	return extname(filename).toLowerCase() in MIME_BY_EXT;
}

export function mimeFor(filename: string): string {
	return MIME_BY_EXT[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

export function kindFor(filename: string): MediaKind {
	return AUDIO_EXTS.has(extname(filename).toLowerCase()) ? 'audio' : 'video';
}

export interface MediaItem {
	filename: string;
	size: number;
	kind: MediaKind;
	/** What a playlist references. Same-origin and path-absolute, so it passes `parseWallState`. */
	url: string;
}

const urlFor = (filename: string) => `/api/media/${encodeURIComponent(filename)}`;

const describe = (filename: string, size: number): MediaItem => ({
	filename,
	size,
	kind: kindFor(filename),
	url: urlFor(filename)
});

/** Everything stored, newest first is NOT promised — the caller sorts if it cares. */
export async function listMedia(dir = mediaDir()): Promise<MediaItem[]> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return []; // no uploads yet is not an error
	}
	const out: MediaItem[] = [];
	for (const filename of names) {
		if (!STORED_NAME.test(filename)) continue;
		try {
			const s = await stat(join(dir, filename));
			if (s.isFile()) out.push(describe(filename, s.size));
		} catch {
			// vanished between readdir and stat; not this request's problem
		}
	}
	return out;
}

/** Idempotent by construction: same bytes, same name, no rewrite. */
export async function saveMedia(
	originalName: string,
	bytes: Uint8Array,
	dir = mediaDir()
): Promise<MediaItem> {
	const ext = extname(originalName).toLowerCase();
	const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
	const filename = `${hash}${ext}`;
	await mkdir(dir, { recursive: true });
	const path = join(dir, filename);
	if (!existsSync(path)) await writeFile(path, bytes);
	return describe(filename, bytes.byteLength);
}

/**
 * Open for streaming, with its size. Null when absent.
 *
 * Streamed, never buffered: the device serving this is the same Pi running the
 * render loop, and materialising a whole clip per request is allocation landing
 * exactly where dropped frames are visible on the wall.
 *
 * Range/206 was deliberately absent, inherited from aero-1: streaming removes
 * the buffer, Range buys SEEKING, and nothing seeked -- the cabin played a
 * track start to finish from an immutable URL. That reasoning was sound while
 * the only consumer was `<audio>`.
 *
 * `MediaStage` then started rendering `<video>`, which IS a seekable surface,
 * and an MP4 whose `moov` atom sits at the END of the file cannot begin
 * playback until the whole clip has arrived -- on a Pi, over venue WiFi, with
 * `loop` refetching. So this now does what that docstring said to do when the
 * day came: the header and the 206 together, never one without the other.
 */
export async function openMedia(
	filename: string,
	dir = mediaDir(),
	range?: { start: number; end: number }
): Promise<{ stream: ReadableStream<Uint8Array>; size: number } | null> {
	if (!STORED_NAME.test(filename)) return null;
	const path = join(dir, filename);
	if (!existsSync(path)) return null;
	const info = await stat(path);
	if (!info.isFile()) return null;
	return {
		// node:stream/web vs DOM ReadableStream: structurally identical, two
		// declarations, and only one is what `Response` accepts.
		stream: Readable.toWeb(
			createReadStream(path, range)
		) as unknown as ReadableStream<Uint8Array>,
		/** Bytes this stream will yield -- the slice, not the file. */
		size: range ? range.end - range.start + 1 : info.size
	};
}

/**
 * Size of a stored file, or null when there is nothing to serve.
 *
 * Separate from `openMedia` because a Range header cannot be parsed without
 * knowing the total size, and the range has to be decided before the stream is
 * opened. Two stats per request, on a device serving a handful of files to
 * three clients on its own LAN -- the alternative is `openMedia` growing an
 * HTTP-header parameter, which puts request parsing inside the storage layer.
 */
export async function statMedia(filename: string, dir = mediaDir()): Promise<number | null> {
	if (!STORED_NAME.test(filename)) return null;
	const path = join(dir, filename);
	if (!existsSync(path)) return null;
	const info = await stat(path);
	return info.isFile() ? info.size : null;
}
