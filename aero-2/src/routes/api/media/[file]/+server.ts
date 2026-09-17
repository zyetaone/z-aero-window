/**
 * GET /api/media/<name> — serve one stored file.
 *
 * Streamed, never buffered: this Pi is also running the render loop.
 *
 * Immutable caching is safe because the name IS the content hash — a changed
 * file is a different URL, so a pane that has played a track once never
 * refetches it, and three panes starting the same clip hit their own caches
 * rather than this socket.
 *
 * Range is honoured, and `Accept-Ranges` is only ever sent because it is.
 * `<audio>` never needed it; `<video>` does — an MP4 with its `moov` atom at
 * the end cannot start until the whole clip lands, and `loop` refetches. The
 * range arithmetic is `parseRange`, shared with the tile route rather than
 * re-derived: its `size === 0` and `end < start` branches are each a bug that
 * reached a `Content-Range` header once already.
 *
 * Path traversal cannot reach here: both `statMedia` and `openMedia` accept
 * only names matching `STORED_NAME`, generated from a hash and never taken
 * from an uploader. A request for anything else is a probe and gets the same
 * 404 as a genuine miss.
 */

import { lanCorsHeaders } from '#lib/server/cors.js';
import { mimeFor, openMedia, statMedia } from '#lib/server/media-store.js';
import { parseRange } from '#lib/server/tiles.js';
import type { RequestHandler } from './$types';

const IMMUTABLE = 'public, max-age=31536000, immutable';

export const GET: RequestHandler = async ({ params, request }) => {
	const cors = lanCorsHeaders(request.headers.get('origin'));
	const name = params.file ?? '';

	const total = await statMedia(name);
	if (total === null) return new Response('Not found', { status: 404, headers: cors });

	const range = parseRange(request.headers.get('range'), total);
	if (range === 'unsatisfiable') {
		return new Response('Range Not Satisfiable', {
			status: 416,
			headers: { ...cors, 'Content-Range': `bytes */${total}`, 'Accept-Ranges': 'bytes' }
		});
	}

	const found = await openMedia(name, undefined, range ?? undefined);
	if (!found) return new Response('Not found', { status: 404, headers: cors });

	return new Response(found.stream, {
		status: range ? 206 : 200,
		headers: {
			...cors,
			'Content-Type': mimeFor(name),
			'Content-Length': String(found.size),
			'Accept-Ranges': 'bytes',
			'Cache-Control': IMMUTABLE,
			...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${total}` } : {})
		}
	});
};
