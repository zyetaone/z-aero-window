/**
 * GET/POST /api/wall — the one shared config, and the one path that changes it.
 *
 * GET is a conditional poll, not a push channel. Correctness here depends on
 * applying at the wall second the snapshot names, not on when it arrived, so a
 * bus buys latency only — and it grows back the replay buffer, keep-alive and
 * reconnection that ADR-007 exists to prevent. A ~2 s poll against a weak ETag
 * costs one 304 per pane per two seconds.
 *
 * POST is the single writer. The body is a WallState; version and
 * applyAtWallSec are the server's.
 */

import { json } from '@sveltejs/kit';

import { requireBearer } from '#lib/server/auth.js';
import { readLimitedJson } from '#lib/server/body.js';
import { corsPreflight, lanCorsHeaders, withCors } from '#lib/server/cors.js';
import { isLoopback } from '#lib/server/loopback.js';
import { pushWall, readWall } from '#lib/server/wall-store.js';
import { MAX_WALL_BYTES, parseWallState } from '#lib/wall.js';
import type { RequestHandler } from './$types';


const wallPath = () => process.env.AERO_WALL_PATH ?? undefined;

export const OPTIONS: RequestHandler = corsPreflight('GET, POST, OPTIONS');

export const GET: RequestHandler = ({ request }) => {
	const cors = lanCorsHeaders(request.headers.get('origin'));
	const snapshot = readWall(wallPath());

	/**
	 * Weak, and keyed on the version alone: the version IS the identity of a
	 * snapshot, so two responses with the same version are equivalent for a
	 * poller's purposes even though `applyAtWallSec` is already in the past on
	 * the second one.
	 */
	const etag = `W/"${snapshot.version}"`;
	if (request.headers.get('if-none-match') === etag) {
		return new Response(null, { status: 304, headers: { ...cors, etag } });
	}

	return json(snapshot, { headers: { ...cors, etag, 'cache-control': 'no-cache' } });
};

/**
 * Loopback, or the admin token.
 *
 * The pane's own operator drawer runs in the browser ON the Pi, so it reaches
 * this over loopback and needs no credential — which is what keeps a fresh
 * device usable with no configuration, and is why v1's `/api/internal/token`
 * could be dropped rather than replaced.
 *
 * Anything else is a machine on the venue LAN, and repainting a client's wall
 * is not something an unauthenticated LAN peer should be able to do. The plan
 * listed auth here as deliberately unbuilt; this is the deliberate decision,
 * made rather than deferred, and it costs one call. Fail-closed for remote
 * callers when AERO_ADMIN_TOKEN is unset: 503, never open.
 */
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const cors = lanCorsHeaders(request.headers.get('origin'));

	if (!isLoopback(getClientAddress())) {
		const refusal = requireBearer(
			request,
			process.env.AERO_ADMIN_TOKEN,
			'wall push from off-device (AERO_ADMIN_TOKEN)'
		);
		if (refusal) return withCors(refusal, cors);
	}

	const body = await readLimitedJson<unknown>(request, MAX_WALL_BYTES);
	if (!body.ok) return withCors(body.response, cors);

	const state = parseWallState(body.value);
	if (!state) {
		return json(
			{ error: 'invalid wall state — a push must carry every wall key, with legal values' },
			{ status: 400, headers: cors }
		);
	}

	return json(pushWall(state, Date.now() / 1000, wallPath()), { headers: cors });
};
