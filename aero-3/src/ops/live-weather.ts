/**
 * Live sky weather — Open-Meteo through the server, applied per visit.
 *
 * WHY THIS EXISTS: a visit's weather was a URL pin, a wall push or the day's
 * static regime and nothing else — the window could fly under a real monsoon
 * in slate-grey stillness because nobody told it otherwise. Open-Meteo is
 * free, keyless and CORS-open, but the kiosk CSP is same-origin-only and a
 * fielded Pi is offline-first by premise, so the browser never calls the
 * provider directly. This module shapes the upstream call and the mapping
 * (the `/api/weather` route in server.ts owns fetching + caching), and
 * `fetchLiveWeather` is the pane's one call at boot.
 *
 * Ported from aero-2 (src/lib/server/weather.ts + /api/weather) and adapted
 * to aero-3's shape:
 *
 *  - The union is aero-3's (REGIME_NAMES: clear, fair, scattered, towering,
 *    cirrus, hazy, overcast, storm), not aero-2's five. WMO rain maps to
 *    'overcast' (aero-3's rainy grey deck — there is no 'rain' regime), fog
 *    to 'hazy' (milky and rainless; aero-3's overcast always rains on the
 *    glass, which fog must not), snow to 'overcast' (grey diffuse, as aero-2).
 *  - aero-2 applies readings at minute boundaries mid-slot and expires them,
 *    because its `weatherAt` treats any applied value as a permanent pin.
 *    aero-3 decides weather ONCE per visit, at boot, and re-decides at the
 *    next boot — so a live reading is authoritative for exactly the visit it
 *    was fetched for, no expiry, no pin-forever, and a pane that misses one
 *    fetch (offline, slow) converges at the next boundary. The discipline
 *    that survives is the one that matters: the reading APPLIES at the visit
 *    boundary (boot, wall-clock aligned), never at a fetch-resolve second.
 *    Panes boot within a second or two of the boundary, so their fetches hit
 *    the wall server's 10-minute cache and share one reading by construction.
 *    A pane that boots MID-slot (a kiosk restart at 10:04) fetches its own
 *    reading and may diverge from its neighbours until the next boundary —
 *    the aero-2 "mount fast path", accepted for the same reason: bounded to
 *    one visit, and the wall clock takes over at the next one.
 *
 * Offline is not an error here, it is the premise: no fetch, no change — the
 * daily static regime stands. A stale cached reading stands in for a dead
 * provider for an hour; past that, 503 and the pane flies today's weather.
 */
import { REGIME_NAMES } from '#flight/weather.ts';

/** A reading serves every boot in the same 10-minute slot (the grid the visits run on); the next slot asks upstream again. */
export const CACHE_TTL_MS = 10 * 60 * 1000;
const sameSlot = (a: number, b: number) => Math.floor(a / CACHE_TTL_MS) === Math.floor(b / CACHE_TTL_MS);
/** A stale reading may stand in for a dead provider this long, then it is weather no more. */
export const STALE_MAX_MS = 60 * 60 * 1000;
/** Eleven places, a few rotations, an admin preview: 64 cells is an order of magnitude of headroom. */
export const MAX_CACHE_ENTRIES = 64;
const UPSTREAM_TIMEOUT_MS = 10_000;
/** The pane's own call to its server: "a pane never waits on it" (the fetchWall rule). */
export const PANE_TIMEOUT_MS = 2_000;

/** The shape a fetch stub (and a real fetch) satisfies: url + init in, Response out. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type LiveWeatherReading = {
	/** A member of REGIME_NAMES — the only names a pane may fly. */
	weather: string;
	/** Cloud cover 0..100, as reported — observability, not control. */
	cloudCover: number;
	/** Raw WMO code — same reason. */
	code: number;
};

/** Open-Meteo forecast endpoint — latitude/longitude/current, nothing else. */
export function openMeteoUrl(lat: number, lon: number): string {
	const params = new URLSearchParams({
		latitude: String(lat),
		longitude: String(lon),
		current: 'weather_code,cloud_cover,wind_speed_10m',
		timezone: 'auto',
		forecast_days: '1'
	});
	return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
}

/**
 * WMO weather code + cloud cover → one of aero-3's regimes.
 *
 * Precipitation codes win over the cover fraction: a thunderstorm under a
 * 40% deck is still a storm, and drizzle under clear sky is still rain. Snow
 * has no dedicated look — it reads as 'overcast' (low, grey, diffuse), which
 * is what aero-3 does with overcast already. Fog is 'hazy' (milky, no rain:
 * aero-3's overcast always rains on the glass). Everything else follows the
 * cover fraction with the same 25/60 splits aero-2 used, so live and daily
 * skies agree on what "scattered" and "overcast" mean.
 */
export function mapOpenMeteoToWeather(code: number, cloudCover: number): string {
	if (code >= 95 && code <= 99) return 'storm';
	if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'overcast'; // rain: the rainy grey deck
	if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'overcast'; // snow: grey diffuse
	if (code >= 45 && code <= 48) return 'hazy'; // fog: milky, rainless
	if (cloudCover >= 60) return 'overcast';
	if (cloudCover >= 25) return 'scattered';
	return 'clear';
}

/**
 * Parse an Open-Meteo `current` payload. Returns null on anything unexpected
 * (shape change, missing fields, NaN) — the caller keeps the current weather
 * instead. Never throws: a provider hiccup must not become a 500 that a
 * poller retries into a storm of its own.
 */
export function parseOpenMeteo(body: unknown): LiveWeatherReading | null {
	try {
		if (typeof body !== 'object' || body === null) return null;
		const current = (body as { current?: unknown }).current;
		if (typeof current !== 'object' || current === null) return null;
		const c = current as Record<string, unknown>;
		const code = Number(c.weather_code);
		const cloudCover = Number(c.cloud_cover);
		if (!Number.isFinite(code) || !Number.isFinite(cloudCover)) return null;
		return {
			weather: mapOpenMeteoToWeather(code, cloudCover),
			cloudCover: Math.max(0, Math.min(100, cloudCover)),
			code
		};
	} catch {
		return null;
	}
}

type CacheEntry = LiveWeatherReading & { fetchedAt: number };
type CacheAnswer =
	| (CacheEntry & { fromCache: boolean; stale: boolean })
	| null; // nothing at all: the route answers 503 and the pane holds course

/**
 * The route's one cache, bounded and clocked by injection (no fake timers in
 * bun:test). One entry per rounded 0.1° cell, fresh for CACHE_TTL_MS; past it
 * the route asks upstream again, and a failed upstream serves the stale
 * reading (stale: true) up to STALE_MAX_MS, after which there is no weather.
 */
export class WeatherCache {
	#cache = new Map<string, CacheEntry>();
	#now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** Test seam — the suite drives expiry without sleeping. */
	clear(): void {
		this.#cache.clear();
	}

	/** Test seam — the bound is only observable from inside. */
	size(): number {
		return this.#cache.size;
	}

	async get(lat: number, lon: number, fetchFn: FetchLike = fetch): Promise<CacheAnswer> {
		const key = cellKey(lat, lon);
		const now = this.#now();
		// Read-side ceiling too: eviction runs on write, and an offline server may
		// not write for hours — a day-old reading must not serve as "stale".
		const cached = this.#cache.get(key);
		const hit = cached && now - cached.fetchedAt <= STALE_MAX_MS ? cached : undefined;
		if (hit && sameSlot(now, hit.fetchedAt)) return { ...hit, fromCache: true, stale: false };

		const reading = await fetchReading(lat, lon, fetchFn);
		if (reading) {
			const entry: CacheEntry = { ...reading, fetchedAt: now };
			remember(this.#cache, key, entry, now);
			return { ...entry, fromCache: false, stale: false };
		}

		// Provider down but a (stale) reading exists: say so honestly and let the
		// pane decide. Nothing cached at all: null, and the route answers 503.
		return hit ? { ...hit, fromCache: true, stale: true } : null;
	}
}

/**
 * Insert most-recent-last, then trim: anything past the stale ceiling, and
 * the oldest beyond the cap. `delete` before `set` so a refreshed cell moves
 * to the end of the Map's insertion order, which is the recency order the
 * cap evicts by.
 */
function remember(cache: Map<string, CacheEntry>, key: string, entry: CacheEntry, now: number): void {
	cache.delete(key);
	cache.set(key, entry);
	for (const [k, v] of cache) {
		if (now - v.fetchedAt > STALE_MAX_MS) cache.delete(k);
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

async function fetchReading(lat: number, lon: number, fetchFn: FetchLike): Promise<LiveWeatherReading | null> {
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

// ─── The pane's one call at boot ──────────────────────────────────────────────

/** The pane's own server (or the wall origin it already polls): same-origin proxy, one shared cache. */
export function liveWeatherUrl(origin: string, lat: number, lon: number): string {
	return `${origin}/api/weather?lat=${lat}&lon=${lon}`;
}

/** A pane trusts only a real regime name from its own server; anything else is no reading. */
export function parseLiveWeather(body: unknown): string | null {
	try {
		if (typeof body !== 'object' || body === null) return null;
		const weather = (body as { weather?: unknown }).weather;
		return typeof weather === 'string' && (REGIME_NAMES as readonly string[]).includes(weather) ? weather : null;
	} catch {
		return null;
	}
}

/**
 * One fetch per visit, at boot, from the origin the wall comes from ('' = this
 * pane's own server). Bounded by PANE_TIMEOUT_MS like fetchWall: a pane never
 * waits on the sky. Null on any failure — the daily static regime stands.
 */
export async function fetchLiveWeather(
	origin: string,
	lat: number,
	lon: number,
	timeoutMs = PANE_TIMEOUT_MS,
	fetchFn: FetchLike = fetch
): Promise<string | null> {
	try {
		const res = await fetchFn(liveWeatherUrl(origin, lat, lon), { signal: AbortSignal.timeout(timeoutMs) });
		if (!res.ok) return null;
		return parseLiveWeather(await res.json());
	} catch {
		return null;
	}
}