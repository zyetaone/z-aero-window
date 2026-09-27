/**
 * Local tile cache selection.
 *
 * Wiring VITE_TILE_SERVER_URL is what finally makes the packaged tile cache
 * (tools/tile-packager, ADR-002) do anything — it had been set nowhere in
 * deploy/, so every fielded Pi streamed imagery and terrain from the public
 * internet.
 *
 * The hazard it introduces, and what these pin: base imagery has NO per-tile
 * fallback. getSatelliteImagery returns exactly one URL and that is the only
 * source, so choosing local against an empty TILE_DIR means a globe of 404s —
 * base colour everywhere. Terrain degrades on its own (local -> Ion ->
 * ellipsoid); imagery cannot. So availability must be resolved BEFORE the
 * source is chosen, and "the route answered 200" is not availability — the
 * route answers 200 with an empty cache too.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const TILE_URL = '/api/tiles';

async function load() {
	return await import('$lib/world/cesium-setup');
}

beforeEach(() => {
	vi.resetModules();
	vi.stubEnv('VITE_TILE_SERVER_URL', TILE_URL);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe('getSatelliteImagery — local vs remote', () => {
	it('uses the packaged cache when it is available', async () => {
		const { getSatelliteImagery } = await load();
		const cfg = getSatelliteImagery(true);
		expect(cfg.label).toBe('local-sentinel2');
		expect(cfg.url).toContain(TILE_URL);
	});

	it('falls back to the remote host when the cache is empty', async () => {
		const { getSatelliteImagery } = await load();
		const cfg = getSatelliteImagery(false);
		// The regression: this used to key on VITE_TILE_SERVER_URL alone, so a
		// device with the flag set but no tiles rendered nothing at all.
		expect(cfg.label).not.toBe('local-sentinel2');
		expect(cfg.url).toMatch(/^https?:\/\//);
	});
});

describe('checkLocalTileServer', () => {
	function stubHealth(body: unknown, ok = true) {
		vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
			ok,
			json: () => Promise.resolve(body),
		})));
	}

	it('reports available when the cache holds layers', async () => {
		stubHealth({ status: 'ok', hasTiles: true, layers: ['sentinel2'] });
		const { checkLocalTileServer } = await load();
		expect(await checkLocalTileServer()).toBe(true);
	});

	it('exposes the probed layer list for layer-specific decisions', async () => {
		// Health probe still reports viirs-roads for legacy caches; runtime uses vector roads.
		stubHealth({ status: 'ok', hasTiles: true, layers: ['sentinel2', 'viirs-roads'] });
		const { checkLocalTileServer, localTileLayerAvailable } = await load();
		await checkLocalTileServer();
		expect(localTileLayerAvailable('viirs-roads')).toBe(true);
		expect(localTileLayerAvailable('cartodb-dark')).toBe(false);
	});

	it('answers false for every layer when the server omits the list (older deploys)', async () => {
		stubHealth({ status: 'ok' });
		const { checkLocalTileServer, localTileLayerAvailable } = await load();
		await checkLocalTileServer();
		expect(localTileLayerAvailable('viirs-roads')).toBe(false);
	});

	it('reports UNavailable when the route answers 200 with an empty cache', async () => {
		// The whole reason /health grew a hasTiles field: a bare {status:'ok'}
		// could not tell "server up, cache populated" from "server up, cache
		// empty", and the second silently blanked the world.
		stubHealth({ status: 'ok', hasTiles: false, layers: [] });
		const { checkLocalTileServer } = await load();
		expect(await checkLocalTileServer()).toBe(false);
	});

	it('treats a server that omits hasTiles as available (older deploys)', async () => {
		stubHealth({ status: 'ok' });
		const { checkLocalTileServer } = await load();
		expect(await checkLocalTileServer()).toBe(true);
	});

	it('reports unavailable on a non-ok response', async () => {
		stubHealth({}, false);
		const { checkLocalTileServer } = await load();
		expect(await checkLocalTileServer()).toBe(false);
	});

	it('reports unavailable when the probe throws (server down)', async () => {
		vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
		const { checkLocalTileServer } = await load();
		expect(await checkLocalTileServer()).toBe(false);
	});

	it('short-circuits without a fetch when no tile server is configured', async () => {
		vi.stubEnv('VITE_TILE_SERVER_URL', '');
		vi.resetModules();
		const spy = vi.fn();
		vi.stubGlobal('fetch', spy);
		const { checkLocalTileServer } = await load();
		expect(await checkLocalTileServer()).toBe(false);
		expect(spy).not.toHaveBeenCalled();
	});
});
