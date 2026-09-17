import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	isAllowedExtension,
	kindFor,
	listMedia,
	maxUploadBytes,
	mimeFor,
	openMedia,
	statMedia,
	saveMedia,
	STORED_NAME
} from '#lib/server/media-store.js';

/**
 * A tmpdir, never `data/`. `data/**` is gitignored, so a suite that reads a
 * committed fixture there passes locally and takes CI red — the trap this repo
 * has already paid for once.
 */
let dir = '';
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'aero-media-'));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const bytes = (s: string) => new TextEncoder().encode(s);

describe('media-store', () => {
	it('classifies what the cabin can actually play, and refuses the rest', () => {
		for (const n of ['a.mp3', 'a.m4a', 'a.ogg', 'a.opus', 'a.wav', 'a.flac']) {
			expect(isAllowedExtension(n), n).toBe(true);
			expect(kindFor(n), n).toBe('audio');
		}
		for (const n of ['a.mp4', 'a.webm']) {
			expect(isAllowedExtension(n), n).toBe(true);
			expect(kindFor(n), n).toBe('video');
		}
		// No reader in the cabin renders these, so the upload surface must not
		// accept them.
		for (const n of ['a.png', 'a.svg', 'a.html', 'a.js', 'a.sh', 'a', 'a.MP3.exe']) {
			expect(isAllowedExtension(n), n).toBe(false);
		}
		expect(mimeFor('a.mp3')).toBe('audio/mpeg');
		expect(mimeFor('a.unknown')).toBe('application/octet-stream');
	});

	it('is case-insensitive about the extension an operator typed', () => {
		expect(isAllowedExtension('SONG.MP3')).toBe(true);
		expect(kindFor('CLIP.MP4')).toBe('video');
	});

	/**
	 * Content addressing is what makes `Cache-Control: immutable` honest. If the
	 * same bytes could ever land at two names, a pane could hold a stale URL
	 * forever.
	 */
	it('gives identical bytes one name, whatever they were called', async () => {
		const a = await saveMedia('morning.mp3', bytes('same'), dir);
		const b = await saveMedia('evening.mp3', bytes('same'), dir);
		expect(b.filename).toBe(a.filename);
		expect(STORED_NAME.test(a.filename), a.filename).toBe(true);

		const c = await saveMedia('morning.mp3', bytes('different'), dir);
		expect(c.filename).not.toBe(a.filename);

		expect((await listMedia(dir)).length, 'the duplicate must not be stored twice').toBe(2);
	});

	it('reports size, kind and a path-absolute url a wall push would accept', async () => {
		const item = await saveMedia('x.mp3', bytes('hello'), dir);
		expect(item.size).toBe(5);
		expect(item.kind).toBe('audio');
		// `parseWallState` only accepts `/x` or http(s) — a bare or relative URL
		// would be silently unpushable.
		expect(item.url.startsWith('/api/media/')).toBe(true);
	});

	it('lists nothing, rather than throwing, before the first upload', async () => {
		expect(await listMedia(join(dir, 'never-created'))).toEqual([]);
	});

	/**
	 * The store only ever serves names it generated. Anything else is a probe,
	 * and gets the same answer as a genuine miss.
	 */
	it('will not open a name it did not generate', async () => {
		await saveMedia('x.mp3', bytes('hello'), dir);
		for (const probe of [
			'../../../etc/passwd',
			'..%2f..%2fetc%2fpasswd',
			'wall.json',
			'0123456789abcdef.mp3/../../secret',
			'ZZZZZZZZZZZZZZZZ.mp3'
		]) {
			expect(await openMedia(probe, dir), probe).toBeNull();
		}
	});

	it('ignores files in the directory that it did not put there', async () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'notes.txt'), 'hand-dropped');
		writeFileSync(join(dir, 'song.mp3'), 'not content-addressed');
		await saveMedia('real.mp3', bytes('real'), dir);
		const listed = await listMedia(dir);
		expect(listed.map((m) => m.filename)).toHaveLength(1);
	});

	it('streams what it stored, byte for byte', async () => {
		const item = await saveMedia('x.wav', bytes('abcdef'), dir);
		const found = await openMedia(item.filename, dir);
		expect(found).not.toBeNull();
		expect(found!.size).toBe(6);
		const read = new Uint8Array(await new Response(found!.stream).arrayBuffer());
		expect(new TextDecoder().decode(read)).toBe('abcdef');
	});

	/**
	 * `<video>` is the seekable surface the no-Range docstring said to wait for.
	 * A slice has to be the slice asked for -- an off-by-one here becomes a
	 * `Content-Range` that disagrees with the body, which players handle by
	 * stalling silently rather than erroring.
	 */
	it('streams a byte slice when asked for one', async () => {
		const item = await saveMedia('x.wav', bytes('abcdef'), dir);
		const found = await openMedia(item.filename, dir, { start: 1, end: 3 });
		expect(found).not.toBeNull();
		expect(found!.size, 'Content-Length must describe the slice, not the file').toBe(3);
		const read = await new Response(found!.stream).text();
		expect(read).toBe('bcd');
	});

	it('reports a size for a stored file and nothing for a probe', async () => {
		const item = await saveMedia('x.wav', bytes('abcdef'), dir);
		expect(await statMedia(item.filename, dir)).toBe(6);
		// Same allowlist as openMedia: a name that is not a hash is not a file.
		expect(await statMedia('../../etc/passwd', dir)).toBeNull();
		expect(await statMedia('song.mp3', dir)).toBeNull();
	});

	it('takes its size cap from the environment, with a sane default', () => {
		expect(maxUploadBytes({} as NodeJS.ProcessEnv)).toBe(50 * 1024 * 1024);
		expect(maxUploadBytes({ AERO_MEDIA_MAX_MB: '200' } as unknown as NodeJS.ProcessEnv)).toBe(
			200 * 1024 * 1024
		);
		// Junk must not disable the cap.
		for (const v of ['', 'lots', '0', '-5']) {
			expect(
				maxUploadBytes({ AERO_MEDIA_MAX_MB: v } as unknown as NodeJS.ProcessEnv),
				v
			).toBe(50 * 1024 * 1024);
		}
	});
});
