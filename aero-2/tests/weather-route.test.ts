import { describe, it, expect, vi, afterEach } from 'vitest';
import { GET, __clearWeatherCache } from '../src/routes/api/weather/+server.js';

function call(lat: string, lon: string): Promise<Response> {
	const u = `http://localhost/api/weather?lat=${lat}&lon=${lon}`;
	return GET({ url: new URL(u), request: new Request(u) } as never) as Promise<Response>;
}

afterEach(() => {
	__clearWeatherCache();
	vi.unstubAllGlobals();
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
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('offline');
			})
		);
		const res = await call('19.07', '72.87');
		expect(res.status).toBe(503);
	});
});
