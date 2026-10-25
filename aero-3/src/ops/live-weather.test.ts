import { expect, test } from 'bun:test';
import { REGIME_NAMES } from '#flight/weather.ts';
import {
	fetchLiveWeather,
	mapOpenMeteoToWeather,
	openMeteoUrl,
	parseLiveWeather,
	parseOpenMeteo,
	WeatherCache,
	MAX_CACHE_ENTRIES,
	STALE_MAX_MS
} from './live-weather.ts';

const reading = async () => Response.json({ current: { weather_code: 95, cloud_cover: 40 } });
const down = async () => new Response('provider down', { status: 503 });

test('WMO codes map onto the aero-3 union, precipitation first', () => {
	expect(mapOpenMeteoToWeather(95, 40)).toBe('storm'); // thunderstorm under a 40% deck is still a storm
	expect(mapOpenMeteoToWeather(51, 10)).toBe('overcast'); // drizzle: the rainy grey deck (no 'rain' regime)
	expect(mapOpenMeteoToWeather(80, 0)).toBe('overcast'); // showers
	expect(mapOpenMeteoToWeather(71, 10)).toBe('overcast'); // snow: grey diffuse
	expect(mapOpenMeteoToWeather(45, 90)).toBe('hazy'); // fog: milky, never rain on the glass (overcast always rains)
	expect(mapOpenMeteoToWeather(1, 80)).toBe('overcast'); // cover 60+
	expect(mapOpenMeteoToWeather(1, 40)).toBe('scattered'); // cover 25-60
	expect(mapOpenMeteoToWeather(1, 5)).toBe('clear');
	// every mapped name is a real regime: a live reading can drive the sky
	for (const code of [95, 51, 71, 45, 1]) expect(REGIME_NAMES).toContain(mapOpenMeteoToWeather(code, 50));
});

test('the upstream URL asks for current conditions only', () => {
	const url = new URL(openMeteoUrl(17.4, 78.4));
	expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast');
	expect(url.searchParams.get('latitude')).toBe('17.4');
	expect(url.searchParams.get('current')).toContain('weather_code');
});

test('a provider payload parses to a reading, or null on anything unexpected', () => {
	expect(parseOpenMeteo({ current: { weather_code: 95, cloud_cover: 40 } })).toEqual({ weather: 'storm', cloudCover: 40, code: 95 });
	expect(parseOpenMeteo({})).toBeNull();
	expect(parseOpenMeteo(null)).toBeNull();
	expect(parseOpenMeteo({ current: { weather_code: 'x', cloud_cover: 40 } })).toBeNull();
	expect(parseOpenMeteo({ current: { weather_code: 95, cloud_cover: 'many' } })).toBeNull();
});

test('the cache serves one reading per 10-minute slot, stale to the hour, gone past it', async () => {
	let t = 1_700_000_400_000; // a slot start (a multiple of 600 s), 200 s in below
	const slotStart = t;
	const cache = new WeatherCache(() => t);
	let calls = 0;
	const upstream = async () => {
		calls++;
		return reading();
	};
	// Miss → upstream, fresh.
	expect(await cache.get(17.44, 78.38, upstream)).toMatchObject({ weather: 'storm', fromCache: false, stale: false });
	expect(calls).toBe(1);
	// Same 0.1° cell (17.44 rounds to 17.4), same slot: the cache answers, upstream is quiet.
	t += 9 * 60_000 + 59_000;
	expect(await cache.get(17.44, 78.38, upstream)).toMatchObject({ weather: 'storm', fromCache: true });
	expect(calls).toBe(1);
	// The next slot asks again even one second later: three panes booting around a boundary must
	// not split on a reading fetched 599 s ago. Provider down → the stale reading stands in, honestly.
	t = slotStart + 10 * 60_000 + 1_000;
	expect(await cache.get(17.4, 78.4, down)).toMatchObject({ weather: 'storm', stale: true });
	expect(calls).toBe(1);
	// Past the stale ceiling: no weather at all (the route answers 503, the pane holds course).
	t += STALE_MAX_MS + 1;
	expect(await cache.get(17.4, 78.4, down)).toBeNull();
});

test('the cache is bounded at MAX_CACHE_ENTRIES, most recent first', async () => {
	const cache = new WeatherCache();
	const upstream = async (url: string) => Response.json({ current: { weather_code: 1, cloud_cover: Number(new URL(url).searchParams.get('latitude')) } });
	for (let i = 0; i < MAX_CACHE_ENTRIES + 10; i++) await cache.get(10 + i, 50, upstream); // distinct 0.1° cells
	expect(cache.size()).toBe(MAX_CACHE_ENTRIES);
	// The freshest cell survives eviction; the oldest is gone (and refetches).
	expect(await cache.get(10 + MAX_CACHE_ENTRIES + 9, 50, upstream)).toMatchObject({ fromCache: true }); // the freshest cell survives
});

test('a pane trusts only a real regime from its own server', () => {
	expect(parseLiveWeather({ weather: 'storm', cloudCover: 40, code: 95 })).toBe('storm');
	expect(parseLiveWeather({ weather: 'monsoon' })).toBeNull();
	expect(parseLiveWeather({ weather: 95 })).toBeNull();
	expect(parseLiveWeather(null)).toBeNull();
});

test('fetchLiveWeather returns the regime, or null on any failure (a pane never waits)', async () => {
	// The pane talks to its OWN server, which answers the server shape ({ weather }), not the provider's.
	const serverReading = async () => Response.json({ weather: 'storm', cloudCover: 40, code: 95 });
	expect(await fetchLiveWeather('', 17.4, 78.4, 500, serverReading)).toBe('storm');
	expect(await fetchLiveWeather('', 17.4, 78.4, 500, down)).toBeNull();
	expect(await fetchLiveWeather('', 17.4, 78.4, 500, async () => new Response('not json', { status: 200 }))).toBeNull();
	expect(await fetchLiveWeather('http://wall:3300', 17.4, 78.4, 500, serverReading)).toBe('storm');
	// The pane times out rather than wait on a slow server: the stub honours the abort signal the way a real fetch does.
	const slow = async (_url: string, init?: RequestInit): Promise<Response> => {
		await new Promise<void>((_resolve, reject) => {
			const t = setTimeout(() => reject(new Error('too late')), 500);
			init?.signal?.addEventListener('abort', () => {
				clearTimeout(t);
				reject(new Error('aborted'));
			});
		});
		return serverReading();
	};
	expect(await fetchLiveWeather('', 17.4, 78.4, 1, slow)).toBeNull();
});