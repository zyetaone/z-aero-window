/**
 * Bundle disk persistence — server-only.
 *
 * Stores each installed bundle as a single JSON file named <id>.json in
 * the configured bundle directory. On first access, the directory is read
 * and an in-memory cache is hydrated. Subsequent reads are served from cache;
 * writes update both cache and disk.
 *
 * Storage contract:
 *   /var/aero/bundles/                (Pi deployment — via AERO_BUNDLES_DIR)
 *   ./data/bundles/                   (dev default)
 *
 * Corrupt/malformed JSON files in the directory are skipped with a warning
 * so one bad file can't crash hydration.
 *
 * This file ends in `.server.ts` so SvelteKit's Vite config refuses to bundle
 * it into the client — node:fs only works server-side.
 */

import { readdir, readFile, writeFile, unlink, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ContentBundle } from '$lib/bundle/types';
import { isContentBundle } from '$lib/bundle/types';

/** Read lazily so tests can redirect via AERO_BUNDLES_DIR between cases. */
function bundlesDir(): string {
	return process.env.AERO_BUNDLES_DIR ?? './data/bundles';
}

/** In-memory mirror of the disk directory. Null until first hydration. */
let cache: Map<string, ContentBundle> | null = null;

async function ensureDir(): Promise<void> {
	if (!existsSync(bundlesDir())) {
		await mkdir(bundlesDir(), { recursive: true });
	}
}

async function hydrate(): Promise<Map<string, ContentBundle>> {
	await ensureDir();
	const map = new Map<string, ContentBundle>();
	let files: string[];
	try {
		files = await readdir(bundlesDir());
	} catch {
		return map;
	}
	for (const filename of files) {
		if (!filename.endsWith('.json')) continue;
		try {
			const raw = await readFile(join(bundlesDir(), filename), 'utf-8');
			const parsed = JSON.parse(raw);
			if (isContentBundle(parsed)) {
				map.set(parsed.id, parsed);
			} else {
				console.warn(`[bundles] skipping malformed file: ${filename}`);
			}
		} catch (e) {
			console.warn(`[bundles] failed to load ${filename}:`, e instanceof Error ? e.message : e);
		}
	}
	return map;
}

// Promise-memo, not value-memo: two concurrent first-touch callers must
// share ONE hydrate. With `if (!cache) cache = await hydrate()`, both
// callers saw cache === null, both hydrated, and the second resolution
// overwrote the first — a saveBundle() on the losing map was then invisible
// to listBundles() until process restart.
let cachePromise: Promise<Map<string, ContentBundle>> | null = null;

async function ensureCache(): Promise<Map<string, ContentBundle>> {
	if (cache) return cache;
	if (!cachePromise) {
		cachePromise = hydrate().then((map) => {
			cache = map;
			return map;
		}).finally(() => {
			cachePromise = null;
		});
	}
	return cachePromise;
}

/** All installed bundles, in insertion order. */
export async function listBundles(): Promise<ContentBundle[]> {
	const map = await ensureCache();
	return Array.from(map.values());
}

/** Install or replace a bundle. Writes to disk and updates cache. */
export async function saveBundle(bundle: ContentBundle): Promise<void> {
	const map = await ensureCache();
	await ensureDir();
	map.set(bundle.id, bundle);
	const path = join(bundlesDir(), `${bundle.id}.json`);
	// Temp + rename: a power cut mid-write used to leave a truncated bundle
	// that failed to parse on the next boot.
	const tmp = `${path}.tmp`;
	await writeFile(tmp, JSON.stringify(bundle, null, 2), 'utf-8');
	await rename(tmp, path);
}

/** Remove a bundle. Returns true if it was present before removal. */
export async function deleteBundle(id: string): Promise<boolean> {
	const map = await ensureCache();
	if (!map.has(id)) return false;
	map.delete(id);
	try {
		await unlink(join(bundlesDir(), `${id}.json`));
	} catch (e) {
		console.warn(`[bundles] unlink failed for ${id}:`, e instanceof Error ? e.message : e);
	}
	return true;
}

/**
 * Clear the in-memory cache so the next access re-hydrates from disk.
 * Disk is the source of truth, so nothing is lost — the cost is one
 * re-read. Used by the memory-pressure guard (server.ts) to shed state
 * under OS memory pressure, and by tests to reset between cases.
 */
export function invalidateCache(): void {
	cache = null;
}
