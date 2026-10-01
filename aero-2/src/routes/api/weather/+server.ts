/**
 * GET /api/weather?lat=&lon= — live sky weather for one point.
 *
 * Same-origin proxy around Open-Meteo (free, keyless): the kiosk CSP is
 * same-origin-only and the browser never calls the provider directly.
 * Response is `{ weather, cloudCover, code, fromCache, fetchedAt }`.
 *
 * Cache: one entry per rounded 0.1° cell, fresh for 10 minutes. Three panes
 * polling the same city share it. Past the TTL the route asks upstream
 * again; if upstream fails and a reading exists it is served with
 * `stale: true` — offline is the premise, not the error — up to
 * `STALE_MAX_MS` old, after which the route answers 503 and the client
 * keeps its current weather (see LiveWeather.svelte). The map is bounded:
 * `MAX_CACHE_ENTRIES` most-recent cells, and anything past the stale
 * ceiling is dropped on write.
 *
 * `Cache-Control: public, max-age=60` only on a 200 with a reading; a 400
 * or 503 is `no-store`, so a proxy or the browser never pins an error.
 *
 * No auth: public data in, public JSON out, same shape as the tile routes.
 */
import { json } from '@sveltejs/kit';

import { lanCorsHeaders } from '#lib/server/cors.js';
import { openMeteoUrl, parseOpenMeteo, type LiveWeatherReading } from '#lib/server/weather.js';
import type { RequestHandler } from './$types';

const CACHE_TTL_MS = 10 * 60 * 1000;
/** A stale reading may stand in for a dead provider this long, then it is weather no more. */
const STALE_MAX_MS = 60 * 60 * 1000;
/** Eleven locations, a few rotations, a drawer preview: 64 cells is an order of magnitude of headroom. */
const MAX_CACHE_ENTRIES = 64;
const UPSTREAM_TIMEOUT_MS = 10_000;

interface CacheEntry extends LiveWeatherReading {
	fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test seam — the suite drives expiry without sleeping. */
export function __clearWeatherCache(): void {
	cache.clear();
}

/** Test seam — the bound is only observable from inside. */
export function __weatherCacheSize(): number {
	return cache.size;
}

/**
 * Insert most-recent-last, then trim: anything past the stale ceiling, and
 * the oldest beyond the cap. `delete` before `set` so a refreshed cell moves
 * to the end of the Map's insertion order, which is the recency order the
 * cap evicts by.
 */
function remember(key: string, entry: CacheEntry): void {
	cache.delete(key);
	cache.set(key, entry);
	for (const [k, v] of cache) {
		if (entry.fetchedAt - v.fetchedAt > STALE_MAX_MS) cache.delete(k);
	}
	while (cache.size > MAX_CACHE_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
}

function cellKey(lat: number, lon: number): string {
	return `${Math.round(lat * 10) / 10},${Math.round(lon * 10) / 10}`;
}

function num(param: string | null): number | null {
	if (param === null || param === '') return null;
	const v = Number(param);
	return Number.isFinite(v) ? v : null;
}

async function fetchReading(
	lat: number,
	lon: number,
	fetchFn: typeof fetch = fetch
): Promise<LiveWeatherReading | null> {
	try {
		const res = await fetchFn(openMeteoUrl(lat, lon), {
			signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
		});
		if (!res.ok) return null;
		return parseOpenMeteo(await res.json());
	} catch {
		return null;
	}
}

export const GET: RequestHandler = async ({ url, request }) => {
	const cors = lanCorsHeaders(request.headers.get('origin'));
	const headers = { ...cors, 'Cache-Control': 'public, max-age=60' };
	const errorHeaders = { ...cors, 'Cache-Control': 'no-store' };
	// A `stale: true` 200 is a stand-in for a dead provider, and it may be
	// STALE_MAX_MS old. It must not carry the same 60 s shared-cache lifetime
	// as a live reading: a proxy (or anything that respects the header) is then
	// entitled to pin one hour-old weather for a further minute, and the panes
	// read that as current. The internal Map cache is still worth 60 s — that
	// is this process reusing its own reading — but an intermediary is not.
	const staleHeaders = { ...cors, 'Cache-Control': 'no-store' };

	const lat = num(url.searchParams.get('lat'));
	const lon = num(url.searchParams.get('lon'));
	if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
		return json(
			{ error: 'lat and lon query params required (-90..90, -180..180)' },
			{ status: 400, headers: errorHeaders }
		);
	}

	const key = cellKey(lat, lon);
	const now = Date.now();
	// Read-side ceiling too: eviction runs on write, and an offline Pi may
	// not write for hours — a day-old reading must not serve as "stale".
	const cached = cache.get(key);
	const hit = cached && now - cached.fetchedAt <= STALE_MAX_MS ? cached : undefined;
	if (hit && now - hit.fetchedAt < CACHE_TTL_MS) {
		return json({ ...hit, fromCache: true }, { headers });
	}

	const reading = await fetchReading(lat, lon);
	if (reading) {
		const entry: CacheEntry = { ...reading, fetchedAt: now };
		remember(key, entry);
		return json({ ...entry, fromCache: false }, { headers });
	}

	// Provider down but a (stale) reading exists: say so honestly and let
	// the client decide. Nothing cached at all: 503, client holds course.
	if (hit) return json({ ...hit, fromCache: true, stale: true }, { headers: staleHeaders });
	return json({ error: 'weather provider unreachable' }, { status: 503, headers: errorHeaders });
};
