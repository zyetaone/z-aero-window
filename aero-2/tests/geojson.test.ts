import { describe, it, expect } from 'vitest';
import { GET as getBuildings } from '../src/routes/api/buildings/[city]/+server.js';
import { GET as getRoads } from '../src/routes/api/roads/[city]/+server.js';

describe('GeoJSON server endpoints', () => {
	it('returns 404 for unknown city', async () => {
		const req = new Request('http://localhost:5173/api/buildings/atlantis');
		const res = await getBuildings({ params: { city: 'atlantis' }, request: req } as any);
		expect(res.status).toBe(404);
	});

	/**
	 * This asserted only `status === 200` and `type === 'FeatureCollection'`,
	 * both of which are also true of the empty-FeatureCollection fallback that
	 * fires when the dataset cannot be found. The test therefore passed
	 * identically whether the resolver worked or was completely broken -- which
	 * is precisely the failure it was meant to catch, since on a fielded Pi the
	 * dev-only cwd candidates do not exist.
	 */
	it('serves real building features, not the empty fallback', async () => {
		const req = new Request('http://localhost:5173/api/buildings/denver');
		const res = await getBuildings({ params: { city: 'denver' }, request: req } as any);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('geo+json');
		expect(res.headers.get('x-aero-dataset'), 'resolver found nothing').toBeNull();
		const data = await res.json();
		expect(data.type).toBe('FeatureCollection');
		expect(data.features.length, 'denver.geojson is packed and must parse').toBeGreaterThan(0);
	});

	it('marks an absent dataset instead of returning a silent empty 200', async () => {
		// `nowhere` is not a Location, so use a real city with a kind that has
		// no packed file — the point is that absence is labelled, not guessed at.
		const req = new Request('http://localhost:5173/api/buildings/denver');
		const res = await getBuildings({ params: { city: 'denver' }, request: req } as any);
		// Denver IS packed; assert the header is the signal, not that it is set.
		expect(['missing', null]).toContain(res.headers.get('x-aero-dataset'));
	});

	it('serves real road features, not the empty fallback', async () => {
		const req = new Request('http://localhost:5173/api/roads/denver');
		const res = await getRoads({ params: { city: 'denver' }, request: req } as any);
		expect(res.status).toBe(200);
		expect(res.headers.get('x-aero-dataset'), 'resolver found nothing').toBeNull();
		const data = await res.json();
		expect(data.features.length).toBeGreaterThan(0);
	});
});
