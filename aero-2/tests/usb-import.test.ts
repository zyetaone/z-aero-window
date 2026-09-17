import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { importFromUsb, usbDir } from '#lib/server/usb-import.js';
import { listMedia } from '#lib/server/media-store.js';

/**
 * The stick is the one input to this device that a stranger formatted.
 *
 * Everything else the media store accepts arrives through an authenticated
 * multipart upload whose filename is discarded; these names are taken as found.
 * So the cases below are the ones that matter: a name that is not a file, a
 * format nothing can play, something too large, and the same clip twice.
 */
describe('importFromUsb', () => {
	let stick: string;
	let store: string;

	beforeEach(() => {
		stick = mkdtempSync(join(tmpdir(), 'aero-stick-'));
		store = mkdtempSync(join(tmpdir(), 'aero-store-'));
	});
	afterEach(() => {
		rmSync(stick, { recursive: true, force: true });
		rmSync(store, { recursive: true, force: true });
	});

	it('reports an absent drive as not mounted, and does not throw', async () => {
		const out = await importFromUsb(join(stick, 'nope'), store);
		expect(out.mounted).toBe(false);
		expect(out.imported).toEqual([]);
	});

	it('imports what the cabin can play and says why it skipped the rest', async () => {
		writeFileSync(join(stick, 'song.mp3'), 'audio-bytes');
		writeFileSync(join(stick, 'clip.mp4'), 'video-bytes');
		writeFileSync(join(stick, 'notes.txt'), 'nope');
		writeFileSync(join(stick, 'tune.aiff'), 'nope');
		mkdirSync(join(stick, 'a-folder'));

		const out = await importFromUsb(stick, store);
		expect(out.mounted).toBe(true);
		expect(out.imported).toHaveLength(2);
		expect(out.skipped.map((s) => s.name).sort()).toEqual(['a-folder', 'notes.txt', 'tune.aiff']);
		// Stored under a generated hash name, never the name on the stick.
		for (const item of out.imported) {
			expect(item.filename).toMatch(/^[0-9a-f]{16}\.(mp3|mp4)$/);
		}
		expect((await listMedia(store)).map((m) => m.filename).sort()).toEqual(
			out.imported.map((i) => i.filename).sort()
		);
	});

	it('is idempotent: the same stick twice is not the same track twice', async () => {
		writeFileSync(join(stick, 'song.mp3'), 'audio-bytes');

		const first = await importFromUsb(stick, store);
		expect(first.imported).toHaveLength(1);
		expect(first.alreadyPresent).toHaveLength(0);

		const second = await importFromUsb(stick, store);
		expect(second.imported, 'a re-import must not re-copy').toHaveLength(0);
		expect(second.alreadyPresent).toHaveLength(1);
		expect(await listMedia(store)).toHaveLength(1);
	});

	/**
	 * The same bytes under two names on the stick is ONE track in the store --
	 * content-addressing, not a bug. Pinned so a future change to saveMedia's
	 * naming cannot quietly turn a re-import into a disk filler.
	 */
	it('collapses duplicate content under different names', async () => {
		writeFileSync(join(stick, 'a.mp3'), 'same-bytes');
		writeFileSync(join(stick, 'b.mp3'), 'same-bytes');
		const out = await importFromUsb(stick, store);
		expect(out.imported.length + out.alreadyPresent.length).toBe(2);
		expect(await listMedia(store)).toHaveLength(1);
	});

	it('refuses a file larger than the cap', async () => {
		writeFileSync(join(stick, 'big.mp3'), 'x'.repeat(100));
		const out = await importFromUsb(stick, store, 10);
		expect(out.imported).toHaveLength(0);
		expect(out.skipped[0].reason).toMatch(/cap/);
	});

	/**
	 * A symlink on the stick pointing out of it is the traversal this module
	 * cannot inherit media-store's exemption from: these names are received,
	 * not generated. `safeResolveWithin` realpaths both ends.
	 */
	it('will not follow a symlink off the drive', async () => {
		const outside = mkdtempSync(join(tmpdir(), 'aero-outside-'));
		writeFileSync(join(outside, 'secret.mp3'), 'not yours');
		try {
			symlinkSync(join(outside, 'secret.mp3'), join(stick, 'escape.mp3'));
		} catch {
			return; // no symlink permission here; the guard is tested in fs-guard
		}
		const out = await importFromUsb(stick, store);
		expect(out.imported).toHaveLength(0);
		expect(out.skipped.map((s) => s.name)).toContain('escape.mp3');
		rmSync(outside, { recursive: true, force: true });
	});

	it('takes its mount point from the environment, with the deploy default', () => {
		expect(usbDir({} as NodeJS.ProcessEnv)).toBe('/media/aero');
		expect(usbDir({ AERO_USB_DIR: '/mnt/x' } as unknown as NodeJS.ProcessEnv)).toBe('/mnt/x');
	});
});
