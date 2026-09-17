/**
 * /api/media — the songs and clips this device can play.
 *
 * GET  lists what is stored. POST uploads one file, multipart/form-data, and
 *      answers with the URL a playlist should reference.
 *
 * WHY THIS EXISTS: aero-2 could play a playlist and had no way to be given one.
 * `audioPlaylist` and `videoPlaylist` were reachable only through `?audio=` and
 * `?media=` URL parameters, so content arrived by someone editing a kiosk URL
 * — per pane, lost on reload, and impossible for an operator who is not at the
 * keyboard. aero-1 solved this with `/api/assets`; this is that, ported to
 * aero-2's idioms and widened to audio.
 *
 * Auth: POST requires `Authorization: Bearer $AERO_ADMIN_TOKEN`, and
 * `requireBearer` 503s when that is unset, so a device that never opted in
 * cannot be filled with media by anyone who reaches it. The token is checked
 * BEFORE the multipart body is touched — an unauthenticated caller must not be
 * able to spend the process's buffering budget.
 *
 * GET is open, matching aero-1. The URLs it returns are the same ones the
 * player fetches, and a listing of content-addressed names on a venue LAN
 * discloses nothing the panes are not already requesting.
 */

import { json } from '@sveltejs/kit';

import { requireBearer } from '#lib/server/auth.js';
import { corsPreflight, lanCorsHeaders, withCors } from '#lib/server/cors.js';
import { isAllowedExtension, listMedia, maxUploadBytes, saveMedia } from '#lib/server/media-store.js';
import type { RequestHandler } from './$types';

export const OPTIONS: RequestHandler = corsPreflight('GET, POST, OPTIONS');

export const GET: RequestHandler = async ({ request }) => {
	const cors = lanCorsHeaders(request.headers.get('origin'));
	return json({ media: await listMedia() }, { headers: cors });
};

export const POST: RequestHandler = async ({ request }) => {
	const refusal = requireBearer(
		request,
		process.env.AERO_ADMIN_TOKEN,
		'media upload (AERO_ADMIN_TOKEN)'
	);
	const cors = lanCorsHeaders(request.headers.get('origin'));
	if (refusal) return withCors(refusal, cors);

	const limit = maxUploadBytes();

	/**
	 * Refuse on the DECLARED length first, when there is one. `formData()`
	 * buffers the whole body before it can be measured, so checking afterwards
	 * means the oversized upload has already cost what the cap exists to
	 * prevent. A missing or lying Content-Length is caught by the real check
	 * below; this one just makes the common case cheap.
	 */
	const declared = Number(request.headers.get('content-length') ?? 0);
	if (Number.isFinite(declared) && declared > limit) {
		return json(
			{ error: `too large: declared ${declared} bytes, limit is ${limit}` },
			{ status: 413, headers: cors }
		);
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return json({ error: 'expected multipart/form-data' }, { status: 400, headers: cors });
	}

	const file = form.get('file');
	if (!(file instanceof File)) {
		return json({ error: 'no `file` part in the upload' }, { status: 400, headers: cors });
	}
	if (file.size > limit) {
		return json(
			{ error: `too large: ${file.size} bytes, limit is ${limit}` },
			{ status: 413, headers: cors }
		);
	}
	if (!isAllowedExtension(file.name)) {
		return json(
			{ error: `unsupported file type: ${file.name}` },
			{ status: 415, headers: cors }
		);
	}

	const item = await saveMedia(file.name, new Uint8Array(await file.arrayBuffer()));
	return json({ ok: true, item }, { headers: cors });
};
