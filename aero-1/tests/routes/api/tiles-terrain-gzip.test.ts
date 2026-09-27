// @vitest-environment node
/**
 * Quantized-mesh tiles land on disk gzipped (ctb-tile's convention), and
 * CesiumTerrainProvider decodes what it receives as raw mesh — so the tile
 * route must announce Content-Encoding: gzip for those files, and ONLY for
 * those: a plain tile, or a gzip-magic file that is not terrain, is served
 * as-is.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const dir = mkdtempSync(join(tmpdir(), 'aero-tiles-'));
let GET: (ev: { params: { path: string }; request: Request }) => Promise<Response>;

beforeAll(async () => {
	mkdirSync(join(dir, 'cesium-terrain', '0', '0'), { recursive: true });
	mkdirSync(join(dir, 'sentinel2', '8', '1'), { recursive: true });
	writeFileSync(join(dir, 'cesium-terrain', '0', '0', '0.terrain'), gzipSync(Buffer.from('mesh')));
	writeFileSync(join(dir, 'cesium-terrain', '0', '0', '1.terrain'), Buffer.from('plain-mesh'));
	writeFileSync(join(dir, 'cesium-terrain', 'layer.json'), '{"format":"quantized-mesh-1.0"}');
	writeFileSync(join(dir, 'sentinel2', '8', '1', '2.jpg'), gzipSync(Buffer.from('not-a-jpeg')));
	process.env.TILE_DIR = dir;
	({ GET } = (await import('../../../src/routes/api/tiles/[...path]/+server')) as never);
});
afterAll(() => {
	delete process.env.TILE_DIR;
	rmSync(dir, { recursive: true, force: true });
});

// Drain the body: the route streams from disk, and an unread stream outlives
// the test and errors once afterAll removes the directory.
const get = async (path: string) => {
	const res = await GET({ params: { path }, request: new Request('http://localhost/api/tiles/' + path) });
	await res.arrayBuffer();
	return res;
};

describe('tile route — terrain content encoding', () => {
	it('announces gzip for a gzipped .terrain tile', async () => {
		const res = await get('cesium-terrain/0/0/0.terrain');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/vnd.quantized-mesh');
		expect(res.headers.get('Content-Encoding')).toBe('gzip');
	});
	it('sends a plain .terrain tile without the header', async () => {
		const res = await get('cesium-terrain/0/0/1.terrain');
		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Encoding')).toBeNull();
	});
	it('never sniffs non-terrain files', async () => {
		const res = await get('sentinel2/8/1/2.jpg');
		expect(res.headers.get('Content-Encoding')).toBeNull();
		expect(res.headers.get('Content-Type')).toBe('image/jpeg');
	});
	it('serves layer.json as JSON and lists both layers in health', async () => {
		expect((await get('cesium-terrain/layer.json')).headers.get('Content-Type')).toBe('application/json');
		const health = JSON.parse(await (await GET({ params: { path: 'health' }, request: new Request('http://localhost/api/tiles/health') })).text()) as { layers: string[] };
		expect(health.layers.sort()).toEqual(['cesium-terrain', 'sentinel2']);
	});
});
