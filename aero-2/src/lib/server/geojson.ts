/**
 * GeoJSON server endpoint helper — serves city buildings, roads and town
 * lamps with ETag validation.
 */
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Location } from '#lib/settings/locations.js';
import { resolveTileDir } from './tiles.js';

/**
 * One resolver, shared with the tile route.
 *
 * This used to re-derive its own: `process.env.TILE_DIR || '/opt/zyeta-aero/tiles'`,
 * 30 lines from `resolveTileDir()`, which does four-step resolution and has
 * tests. The two disagreed everywhere except a provisioned Pi, and the
 * disagreement was invisible because of the fallback below.
 */
const TILE_DIR = resolveTileDir().replace(/\/$/, '');

const HEADERS = {
	'content-type': 'application/geo+json',
	'cache-control': 'public, no-cache'
} as const;

async function etagFor(path: string): Promise<string | null> {
	try {
		const s = await stat(path);
		return `W/"${s.size.toString(36)}-${Math.floor(s.mtimeMs).toString(36)}"`;
	} catch {
		return null;
	}
}

function geojsonCandidates(city: string, kind: 'buildings' | 'roads' | 'towns'): string[] {
	const filename = `${city}.geojson`;
	return [
		resolve(TILE_DIR, `../data/${kind}`, filename),
		resolve(process.cwd(), `data/${kind}`, filename),
		resolve(process.cwd(), `../data/${kind}`, filename)
	];
}

function resolveGeojsonPath(city: string, kind: 'buildings' | 'roads' | 'towns'): string | null {
	return geojsonCandidates(city, kind).find((path) => existsSync(path)) ?? null;
}

export async function serveCityGeojson(
	city: string | undefined,
	kind: 'buildings' | 'roads' | 'towns',
	ifNoneMatch?: string | null
): Promise<Response> {
	if (!city || !Location.isValid(city)) {
		return new Response('Unknown city location', { status: 404 });
	}

	const filePath = resolveGeojsonPath(city, kind);
	if (!filePath) {
		/**
		 * An empty FeatureCollection, because a city with no packed buildings is
		 * a real state the client must render -- but SAID OUT LOUD, because it
		 * is otherwise indistinguishable from a city that genuinely has none.
		 *
		 * That silence is this repo's most expensive recurring bug. An
		 * undecoded DEM tile reading as sea level, /admin rendering 19
		 * characters, a 200 that dropped the field it was sent: every one was
		 * an absence that looked like a measurement. On a fielded Pi this is
		 * the difference between "Denver has no 3D buildings" and "the tile
		 * directory is not where we thought", and nothing in the response
		 * distinguished them.
		 */
		console.warn(
			`[geojson] no ${kind} dataset for "${city}" — tried:\n  ` +
				geojsonCandidates(city, kind).join('\n  ')
		);
		return new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), {
			headers: { ...HEADERS, 'x-aero-dataset': 'missing' }
		});
	}

	const etag = await etagFor(filePath);
	if (etag && ifNoneMatch === etag) {
		return new Response(null, { status: 304, headers: { etag } });
	}

	try {
		const data = await readFile(filePath);
		return new Response(data, {
			headers: {
				...HEADERS,
				...(etag ? { etag } : {})
			}
		});
	} catch {
		return new Response('Failed to read geospatial dataset', { status: 500 });
	}
}
