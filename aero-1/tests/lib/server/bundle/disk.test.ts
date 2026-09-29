// @vitest-environment node

/**
 * Disk persistence tests — use a temp directory via AERO_BUNDLES_DIR env var.
 * Each test gets an isolated temp dir. Runs in Node (not happy-dom) because
 * it touches node:fs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VideoBgBundle } from '$lib/bundle/types';
import * as disk from '$lib/server/bundle/disk';

let tmp: string;

beforeEach(async () => {
	tmp = await mkdtemp(join(tmpdir(), 'aero-bundles-'));
	process.env.AERO_BUNDLES_DIR = tmp;
	disk.invalidateCache();
});

afterEach(async () => {
	delete process.env.AERO_BUNDLES_DIR;
	disk.invalidateCache();
	await rm(tmp, { recursive: true, force: true });
});

const sample = (id: string): VideoBgBundle => ({
	id,
	type: 'video-bg',
	kind: 'sky',
	z: 0.5,
	asset: `/videos/${id}.mp4`,
});

describe('disk.server round-trip', () => {
	it('starts with an empty list when directory is empty', async () => {
		const list = await disk.listBundles();
		expect(list).toEqual([]);
	});

	it('saves a bundle and lists it back', async () => {
		await disk.saveBundle(sample('alpha'));
		const list = await disk.listBundles();
		expect(list).toHaveLength(1);
		expect(list[0].id).toBe('alpha');
	});

	it('persists multiple bundles with distinct ids', async () => {
		await disk.saveBundle(sample('a'));
		await disk.saveBundle(sample('b'));
		await disk.saveBundle(sample('c'));
		const list = await disk.listBundles();
		expect(list.map(b => b.id).sort()).toEqual(['a', 'b', 'c']);
	});

	it('replaces a bundle when saving the same id twice', async () => {
		await disk.saveBundle({ ...sample('x'), opacity: 0.5 });
		await disk.saveBundle({ ...sample('x'), opacity: 0.9 });
		const list = await disk.listBundles();
		expect(list).toHaveLength(1);
		expect((list[0] as VideoBgBundle).opacity).toBe(0.9);
	});

	it('deletes a bundle', async () => {
		await disk.saveBundle(sample('to-go'));
		expect(await disk.deleteBundle('to-go')).toBe(true);
		const list = await disk.listBundles();
		expect(list).toEqual([]);
	});

	it('returns false when deleting a bundle that was never installed', async () => {
		expect(await disk.deleteBundle('ghost')).toBe(false);
	});

	it('auto-creates the bundle directory if missing', async () => {
		// Tear down the temp dir, then save — should recreate.
		await rm(tmp, { recursive: true, force: true });
		await disk.saveBundle(sample('recovery'));
		const list = await disk.listBundles();
		expect(list).toHaveLength(1);
	});

	it('skips malformed JSON files on hydration', async () => {
		disk.invalidateCache();
		await writeFile(join(tmp, 'broken.json'), '{ not valid json', 'utf-8');
		await disk.saveBundle(sample('good'));
		const list = await disk.listBundles();
		expect(list.map(b => b.id)).toEqual(['good']);
	});

	it('skips JSON files that do not match the ContentBundle shape', async () => {
		disk.invalidateCache();
		await writeFile(join(tmp, 'foreign.json'), JSON.stringify({ hello: 'world' }), 'utf-8');
		const list = await disk.listBundles();
		expect(list).toEqual([]);
	});
});
