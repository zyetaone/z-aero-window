/**
 * Live sky weather — Open-Meteo mapping and fetch, server side.
 *
 * WHY THIS EXISTS: the deck's weather was a URL pin or the operator's slider
 * and nothing else — the window could fly under a real monsoon in slate-grey
 * stillness because nobody told it otherwise. Open-Meteo is free, keyless,
 * and CORS-open, but the kiosk's CSP is same-origin-only by design and a
 * fielded Pi is offline-first by premise, so the browser never calls it
 * directly. This module shapes the upstream call and the mapping; the
 * `/api/weather` route owns fetching + caching, and `LiveWeather.svelte`
 * owns polling it. Offline is not an error here, it is the premise: no
 * fetch, no change — the current weather stands.
 *
 * Runtime-free pure mapping (no DOM, no Svelte) so the route and the test
 * suite share it. `Weather` is the const-array union from `flight/view.js`
 * (type-only import: erased, no runtime edge into the flight model).
 */
import type { Weather } from '#lib/wall.js';

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
 * WMO weather code + cloud cover → our five weathers.
 *
 * Precipitation codes win over the cover fraction: a thunderstorm under a
 * 40% deck is still a storm, and drizzle under clear sky is still rain.
 * Fog and snow have no union member — both read as overcast (low, grey,
 * diffuse), which is what the deck, the hillshade and the ground grade do
 * with `overcast` already. Everything else follows the cover fraction with
 * the same 25/60 splits the old director RNG used, so live and pinned skies
 * agree on what "cloudy" means.
 */
export function mapOpenMeteoToWeather(code: number, cloudCover: number): Weather {
	if (code >= 95 && code <= 99) return 'storm';
	if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
	if ((code >= 45 && code <= 48) || (code >= 71 && code <= 77) || code === 85 || code === 86)
		return 'overcast';
	if (cloudCover >= 60) return 'overcast';
	if (cloudCover >= 25) return 'cloudy';
	return 'clear';
}

export interface LiveWeatherReading {
	weather: Weather;
	/** Cloud cover 0..100, as reported — observability, not control. */
	cloudCover: number;
	/** Raw WMO code — same reason. */
	code: number;
}

/**
 * Parse an Open-Meteo `current` payload. Returns null on anything
 * unexpected (shape change, missing fields, NaN) — the caller keeps the
 * current weather instead. Never throws: a provider hiccup must not become
 * a 500 that a poller retries into a storm of its own.
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
