/**
 * GET /api/weather?lat=&lon= — live sky weather for one point.
 *
 * Same-origin proxy around Open-Meteo (free, keyless): the kiosk CSP is
 * same-origin-only and the browser never calls the provider directly.
 * Response is `{ weather, cloudCover, code, fromCache, fetchedAt }`.
 *
 * Cache: one entry per rounded 0.1° cell, 10 minutes. Three panes polling
 * the same city share it, and a provider blip serves stale instead of
 * failing — offline is the premise, not the error. No reading older than
 * the TTL ever leaves here; past that the route answers 503 and the client
 * keeps its current weather (see LiveWeather.svelte).
 *
 * No auth: public data in, public JSON out, same shape as the tile routes.
 */
import { json } from '@sveltejs/kit';

import { lanCorsHeaders } from '#lib/server/cors.js';
import { openMeteoUrl, parseOpenMeteo, type LiveWeatherReading } from '#lib/server/weather.js';
import type { RequestHandler } from './$types';

const CACHE_TTL_MS = 10 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 10_000;

interface CacheEntry extends LiveWeatherReading {
	fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Test seam — the suite drives expiry without sleeping. */
export function __clearWeatherCache(): void {
	cache.clear();
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

	const lat = num(url.searchParams.get('lat'));
	const lon = num(url.searchParams.get('lon'));
	if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
		return json(
			{ error: 'lat and lon query params required (-90..90, -180..180)' },
			{ status: 400, headers }
		);
	}

	const key = cellKey(lat, lon);
	const now = Date.now();
	const hit = cache.get(key);
	if (hit && now - hit.fetchedAt < CACHE_TTL_MS) {
		return json({ ...hit, fromCache: true }, { headers });
	}

	const reading = await fetchReading(lat, lon);
	if (reading) {
		const entry: CacheEntry = { ...reading, fetchedAt: now };
		cache.set(key, entry);
		return json({ ...entry, fromCache: false }, { headers });
	}

	// Provider down but a (stale) reading exists: say so honestly and let
	// the client decide. Nothing cached at all: 503, client holds course.
	if (hit) return json({ ...hit, fromCache: true, stale: true }, { headers });
	return json({ error: 'weather provider unreachable' }, { status: 503, headers });
};
