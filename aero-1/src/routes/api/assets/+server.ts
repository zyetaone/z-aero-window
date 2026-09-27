/**
 * /api/assets — uploaded asset management.
 *
 * GET  → list installed assets ({ filename, size, url })
 * POST → multipart/form-data upload, returns { ok, asset } with the URL the
 *        bundle author should reference. Requires bearer auth.
 *
 * Files are content-addressed (SHA-256), so duplicate uploads are deduped.
 *
 * Auth: POST requires `Authorization: Bearer $AERO_ADMIN_TOKEN`. Returns 503
 * when the env var is unset (fail closed). The token is verified BEFORE the
 * multipart body is parsed so an unauthed attacker can't blow the Node
 * process's body-buffering budget with crafted uploads.
 */

import { json, error } from '@sveltejs/kit';
import { listAssets, saveAsset, isAllowedExtension } from '$lib/server/bundle/assets';
import { readLimitedBlob } from '$lib/http/body';
import { requireAdminToken } from '$lib/http/auth';
import type { RequestHandler } from './$types';

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB cap per upload

export const GET: RequestHandler = async () => {
	const assets = await listAssets();
	return json({ assets });
};

export const POST: RequestHandler = async ({ request }) => {
	requireAdminToken(request);
	// Early-reject via Content-Length header when present — avoids reading the
	// multipart body at all for obviously oversized requests.
	// …and refuse a body with no length at all: `formData()` reads the whole
	// stream before the per-file cap below can run, so a chunked upload had
	// no bound until it was fully in memory.
	const declaredHeader = request.headers.get('content-length');
	if (declaredHeader === null) error(411, 'Content-Length required');
	const declaredLen = Number(declaredHeader);
	if (Number.isFinite(declaredLen) && declaredLen > MAX_BYTES) {
		error(413, `asset too large: declared ${declaredLen} bytes, limit is ${MAX_BYTES} bytes`);
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		error(400, 'expected multipart/form-data');
	}

	const file = form.get('file');
	if (!(file instanceof File)) error(400, 'missing form field "file"');
	if (!isAllowedExtension(file.name)) {
		error(400, 'unsupported file type — allowed: mp4, webm, png, jpg, webp');
	}

	// Stream the file blob through readLimitedBlob — aborts and throws 413
	// before fully buffering into memory if the file exceeds the cap.
	// This covers the case where Content-Length was absent or lied.
	const bytes = await readLimitedBlob(file.stream(), MAX_BYTES);
	const asset = await saveAsset(file.name, bytes);
	return json({ ok: true, asset });
};
