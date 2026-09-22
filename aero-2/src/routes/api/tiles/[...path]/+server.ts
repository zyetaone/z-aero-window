/**
 * Offline Tile Server & PMTiles Range Proxy.
 *
 *   1. WMTS layout  — /api/tiles/{layer}/{z}/{y}/{x}.ext
 *   2. XYZ proxy    — /api/tiles/xyz/{layer}/{z}/{x}/{y}.ext → WMTS on disk
 *   3. Range header — 206 Partial Content for PMTiles archives
 *   4. Health check — GET /api/tiles/health → { status, hasTiles, layers }
 */

import { createReadStream, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { RequestHandler } from './$types';
import {
	parseRange,
	remoteFallbackEnabled,
	remoteTileUrl,
	resolveTileDir,
	resolveTileHealth,
	type TileHealth
} from '#lib/server/tiles.js';
import { corsPreflight, lanCorsHeaders } from '#lib/server/cors.js';
import { safeResolveWithin } from '#lib/server/fs-guard.js';
import { tintViirs } from '#lib/server/viirs-tint.js';

const TILE_DIR = resolveTileDir().replace(/\/$/, '') + '/';

const OCTET = 'application/octet-stream';

/**
 * A raster tile at z/x/y IS its own address: re-packing changes the tiles, not
 * what any given URL means, so a year of `immutable` is correct for those.
 *
 * A PMTiles archive is the opposite. One URL, 3.7 GB behind it, re-packed
 * whenever the DEM is rebuilt -- and served through hundreds of byte-range
 * requests, so a stale copy is not a stale picture, it is a stale DIRECTORY
 * pointing at offsets that no longer mean what they meant. `immutable` on it
 * told every fielded Pi to keep that for a year: a re-packed DEM could not
 * reach the wall without someone clearing a browser cache by hand.
 *
 * Weak ETag plus `no-cache` is what the geojson route already does with the
 * same problem: the client still caches, it just asks first, and a 304 costs
 * nothing next to 3.7 GB.
 */
const MUTABLE_ARCHIVE = /\.pmtiles$/;
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const REVALIDATE_CACHE = 'public, no-cache';

/** Weak validator: size and mtime, the two things a re-pack always changes. */
function fileEtag(filePath: string, size: number): string {
	return `W/"${size.toString(36)}-${Math.floor(statSync(filePath).mtimeMs).toString(36)}"`;
}
const MIME: Record<string, string> = {
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png'
};

const REMOTE_TIMEOUT_MS = 20_000;

function serveTile(
	body: BodyInit,
	contentType: string,
	cors: Record<string, string>,
	extra: Record<string, string> = {},
	cacheControl: string = IMMUTABLE_CACHE
): Response {
	return new Response(body, {
		headers: {
			...cors,
			'Cache-Control': cacheControl,
			...extra,
			'Content-Type': contentType
		}
	});
}

async function serveRemote(url: string, cors: Record<string, string>): Promise<Response | null> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
		if (!res.ok) return null;
		const type = res.headers.get('content-type') ?? OCTET;
		return serveTile(await res.arrayBuffer(), type, cors);
	} catch {
		return null;
	}
}

/**
 * Node `ReadStream` → web `ReadableStream`, abort-safe.
 *
 * A raw `createReadStream(...)` cast to `BodyInit` happens to work until a
 * client goes away mid-tile — which browsers do constantly, because panning
 * cancels in-flight tile requests. undici then closes an already-closed
 * controller and throws `ERR_INVALID_STATE` from a microtask, where there is no
 * request context to catch it, and the whole server process dies.
 *
 * That is a kiosk-fatal bug: one abandoned tile takes down the display until
 * systemd restarts it. Guarding `closed` makes the double-close a no-op, and
 * `cancel()` destroys the fd so aborted requests do not leak file handles.
 */
function nodeStreamToWeb(
	nodeStream: ReturnType<typeof createReadStream>
): ReadableStream<Uint8Array> {
	let closed = false;

	return new ReadableStream<Uint8Array>({
		start(controller) {
			nodeStream.on('data', (chunk) => {
				if (closed) return;
				controller.enqueue(new Uint8Array(chunk as Buffer));
			});
			nodeStream.on('end', () => {
				if (closed) return;
				closed = true;
				controller.close();
			});
			nodeStream.on('error', (err) => {
				if (closed) return;
				closed = true;
				controller.error(err);
			});
		},
		cancel() {
			closed = true;
			nodeStream.destroy();
		}
	});
}

function serveLocalFile(
	filePath: string,
	cors: Record<string, string>,
	rangeHeader: string | null = null,
	ifNoneMatch: string | null = null
): Response {
	const ext = filePath.substring(filePath.lastIndexOf('.'));
	const { size } = statSync(filePath);
	const type = MIME[ext] ?? OCTET;
	const range = parseRange(rangeHeader, size);

	const mutable = MUTABLE_ARCHIVE.test(filePath);
	const cacheControl = mutable ? REVALIDATE_CACHE : IMMUTABLE_CACHE;
	const etag = mutable ? fileEtag(filePath, size) : null;

	// Only on the whole file: a 304 to a range request would have to prove the
	// range still means the same bytes, and `If-Range` is the header for that.
	if (etag && !range && ifNoneMatch === etag) {
		return new Response(null, { status: 304, headers: { ...cors, etag } });
	}

	if (range === 'unsatisfiable') {
		return new Response('Range Not Satisfiable', {
			status: 416,
			headers: { ...cors, 'Content-Range': `bytes */${size}` }
		});
	}

	if (range) {
		const { start, end } = range;
		return new Response(nodeStreamToWeb(createReadStream(filePath, { start, end })), {
			status: 206,
			headers: {
				...cors,
				'Content-Type': type,
				'Content-Length': String(end - start + 1),
				'Content-Range': `bytes ${start}-${end}/${size}`,
				'Accept-Ranges': 'bytes',
				'Cache-Control': cacheControl,
				...(etag ? { etag } : {})
			}
		});
	}

	return serveTile(
		nodeStreamToWeb(createReadStream(filePath)),
		type,
		cors,
		{ 'Content-Length': String(size), 'Accept-Ranges': 'bytes', ...(etag ? { etag } : {}) },
		cacheControl
	);
}

/**
 * Is the offline archive actually able to draw the world?
 *
 * The previous version answered `{status:'ok', hasTiles:true}` whenever ANY
 * subdirectory of TILE_DIR was non-empty, and that is how a pack holding only
 * `terrarium/` (build INPUT — the kiosk never requests it) and a folder of raw
 * Sentinel GeoTIFFs reported green while every `gibs` tile 404'd and the ground
 * rendered as a white sheet. The one dashboard meant to catch a missing pack
 * was structurally incapable of seeing one: it asked "is there something here",
 * and the question is "is what the style requests here".
 *
 * The body lives in `server/tiles.ts` and takes its directory as an argument,
 * so the suite can point it at a temp dir holding a deliberately incomplete
 * pack. This module resolves TILE_DIR once at import, which is right for a
 * server that serves thousands of tiles and useless for a test.
 */
function tileHealth(): TileHealth {
	return resolveTileHealth(TILE_DIR);
}

async function resolveTileResponse(
	path: string,
	cors: Record<string, string>,
	rangeHeader: string | null = null,
	ifNoneMatch: string | null = null
): Promise<Response | 'forbidden' | null> {
	const local = safeResolveWithin(TILE_DIR, path);
	if (local.forbidden) return 'forbidden';
	if (!local.notFound) return serveLocalFile(local.filePath, cors, rangeHeader, ifNoneMatch);

	if (remoteFallbackEnabled()) {
		const remote = remoteTileUrl(path);
		if (remote) {
			const proxied = await serveRemote(remote, cors);
			if (proxied) return proxied;
		}
	}

	return null;
}

/**
 * VIIRS serves tinted, never raw.
 *
 * The frame is EDF-white at the cores; the client has no color ramp
 * (`raster-color` is not a MapLibre paint), so the mask is baked here:
 * luminance → amber alpha + grain tooth (server/viirs-tint.ts). Local pack
 * and dev remote fallback flow through the same tint, one look everywhere.
 * Reads the whole tile (they are tens of KB) because tinting is per-pixel;
 * the immutable cache header means each address pays that once.
 */
async function serveViirsTile(
	wmtsPath: string,
	cors: Record<string, string>
): Promise<Response | null> {
	let bytes: Uint8Array | null = null;
	const local = safeResolveWithin(TILE_DIR, wmtsPath);
	if (!local.forbidden && !local.notFound) {
		try {
			bytes = new Uint8Array(await readFile(local.filePath));
		} catch {
			bytes = null;
		}
	}
	if (!bytes && remoteFallbackEnabled()) {
		const remote = remoteTileUrl(wmtsPath);
		if (remote) {
			try {
				const res = await fetch(remote, { signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS) });
				if (res.ok) bytes = new Uint8Array(await res.arrayBuffer());
			} catch {
				bytes = null;
			}
		}
	}
	if (!bytes) return null;
	try {
		bytes = tintViirs(bytes);
	} catch {
		// Fail open to the raw frame rather than 500ing the city lights.
	}
	const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	return serveTile(body as ArrayBuffer, 'image/png', cors);
}

export const OPTIONS: RequestHandler = corsPreflight('GET, OPTIONS');

export const GET: RequestHandler = async ({ params, request }) => {
	const path = params.path ?? '';
	const cors = lanCorsHeaders(request.headers.get('Origin'));

	if (path === 'health') {
		return new Response(JSON.stringify(tileHealth()), {
			headers: { ...cors, 'Content-Type': 'application/json' }
		});
	}

	const xyzMatch = path.match(/^xyz\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.(.+)$/);
	const wmtsPath = xyzMatch
		? `${xyzMatch[1]}/${xyzMatch[2]}/${xyzMatch[4]}/${xyzMatch[3]}.${xyzMatch[5]}`
		: path;

	const layer = xyzMatch ? xyzMatch[1] : path.split('/')[0];
	if (layer === 'viirs') {
		const tinted = await serveViirsTile(wmtsPath, cors);
		if (tinted) return tinted;
		return new Response('Not found', { status: 404, headers: cors });
	}

	const hit = await resolveTileResponse(
		wmtsPath,
		cors,
		request.headers.get('Range'),
		request.headers.get('If-None-Match')
	);
	if (hit === 'forbidden') return new Response('Forbidden', { status: 403 });
	if (hit) return hit;
	return new Response('Not found', { status: 404, headers: cors });
};
