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
 * Path traversal cannot reach here: `openMedia` accepts only names matching
 * `STORED_NAME`, and those are generated from a hash, never taken from an
 * uploader. A request for anything else is a probe and gets the same 404 as a
 * genuine miss.
 */

import { lanCorsHeaders } from '#lib/server/cors.js';
import { mimeFor, openMedia } from '#lib/server/media-store.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, request }) => {
	const cors = lanCorsHeaders(request.headers.get('origin'));
	const name = params.file ?? '';
	const found = await openMedia(name);
	if (!found) return new Response('Not found', { status: 404, headers: cors });

	return new Response(found.stream, {
		headers: {
			...cors,
			'Content-Type': mimeFor(name),
			'Content-Length': String(found.size),
			'Cache-Control': 'public, max-age=31536000, immutable'
		}
	});
};
