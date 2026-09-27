import { describe, it, expect, vi, afterEach } from 'vitest';
import { GET, __clearWeatherCache, __weatherCacheSize } from '../src/routes/api/weather/+server.js';

const MIN = 60_000;

/** A provider that answers `code` for every cell, counting calls. */
function upstream(code: number, cover = 50) {
	return vi.fn(async () => ({
		ok: true,
		json: async () => ({ current: { weather_code: code, cloud_cover: cover } })
	}));
}
const down = () =>
	vi.fn(async () => {
		throw new Error('offline');
	});

function call(lat: string, lon: string): Promise<Response> {
	const u = `http://localhost/api/weather?lat=${lat}&lon=${lon}`;
	return GET({ url: new URL(u), request: new Request(u) } as never) as Promise<Response>;
}

afterEach(() => {
	__clearWeatherCache();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('GET /api/weather', () => {
	it('400s on missing or wild coordinates', async () => {
		for (const u of [
			'http://localhost/api/weather',
			'http://localhost/api/weather?lat=19',
			'http://localhost/api/weather?lat=x&lon=72',
			'http://localhost/api/weather?lat=190&lon=72'
		]) {
			const res = await GET({ url: new URL(u), request: new Request(u) } as never);
			expect(res.status).toBe(400);
		}
	});

	it('maps the provider reading through and caches the cell', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ current: { weather_code: 80, cloud_cover: 55 } })
			}))
		);
		const first = await call('19.07', '72.87');
		expect(first.status).toBe(200);
		expect(await first.json()).toMatchObject({ weather: 'rain', fromCache: false });

		const second = await call('19.07', '72.87');
		expect(await second.json()).toMatchObject({ weather: 'rain', fromCache: true });
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('503s when the provider is down and nothing is cached', async () => {
		vi.stubGlobal('fetch', down());
		const res = await call('19.07', '72.87');
		expect(res.status).toBe(503);
	});

	it('never lets a proxy pin an error: 400 and 503 are no-store, a reading is cacheable', async () => {
		const bad = await GET({
			url: new URL('http://localhost/api/weather'),
			request: new Request('http://localhost/api/weather')
		} as never);
		expect(bad.headers.get('cache-control')).toBe('no-store');

		vi.stubGlobal('fetch', down());
		const unreachable = await call('19.07', '72.87');
		expect(unreachable.status).toBe(503);
		expect(unreachable.headers.get('cache-control')).toBe('no-store');

		vi.stubGlobal('fetch', upstream(0));
		const ok = await call('19.07', '72.87');
		expect(ok.headers.get('cache-control')).toBe('public, max-age=60');
	});
});

describe('GET /api/weather — cache lifetime', () => {
	// Only Date is faked: AbortSignal.timeout and the happy-dom loop stay real.
	const startClock = (t = 1_700_000_000_000) => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(t);
		return t;
	};

	it('re-asks upstream once the TTL has passed', async () => {
		const t0 = startClock();
		vi.stubGlobal('fetch', upstream(0));
		expect(await (await call('19.07', '72.87')).json()).toMatchObject({ fromCache: false });

		vi.setSystemTime(t0 + 9 * MIN);
		expect(await (await call('19.07', '72.87')).json()).toMatchObject({ fromCache: true });
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);

		vi.setSystemTime(t0 + 11 * MIN);
		vi.stubGlobal('fetch', upstream(95));
		const res = await call('19.07', '72.87');
		expect(await res.json()).toMatchObject({ weather: 'storm', fromCache: false });
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
	});

	it('serves the expired reading as stale while upstream is down, then 503s past the ceiling', async () => {
		const t0 = startClock();
		vi.stubGlobal('fetch', upstream(80));
		await call('19.07', '72.87');

		vi.setSystemTime(t0 + 11 * MIN);
		vi.stubGlobal('fetch', down());
		const stale = await call('19.07', '72.87');
		expect(stale.status).toBe(200);
		expect(await stale.json()).toMatchObject({ weather: 'rain', fromCache: true, stale: true });
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);

		// An hour-old reading is not weather: the client holds course instead.
		vi.setSystemTime(t0 + 61 * MIN);
		const gone = await call('19.07', '72.87');
		expect(gone.status).toBe(503);
	});

	it('is bounded: 64 most-recent cells, and anything past the stale ceiling goes on write', async () => {
		const t0 = startClock();
		vi.stubGlobal('fetch', upstream(0));
		for (let i = 0; i < 70; i++) await call(String(i * 0.5 - 17), '10');
		expect(__weatherCacheSize()).toBe(64);
		// The first six cells were evicted, so the first is a miss again.
		await call('-17', '10');
		expect(globalThis.fetch).toHaveBeenCalledTimes(71);

		// A write an hour and a bit later drops every older entry.
		vi.setSystemTime(t0 + 61 * MIN);
		await call('50', '50');
		expect(__weatherCacheSize()).toBe(1);
	});
});
