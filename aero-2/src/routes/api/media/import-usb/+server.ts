/**
 * POST /api/media/import-usb — copy a pen drive's tracks into the store.
 *
 * Gated on `AERO_ADMIN_TOKEN`, the same credential as an upload and for the
 * same reason: this writes to the device's disk. `requireBearer` 503s when the
 * token is unset, so a device that never opted in cannot be filled by anyone
 * who reaches it.
 *
 * POST rather than GET despite reading a directory — it creates files, and a
 * GET that writes is a GET something will eventually prefetch.
 *
 * `mounted: false` is a 200, not an error. "No stick in the slot" is the
 * answer to the question, and the operator needs to see it on the page rather
 * than as a failed request.
 */

import { json } from '@sveltejs/kit';

import { requireBearer } from '#lib/server/auth.js';
import { corsPreflight, lanCorsHeaders, withCors } from '#lib/server/cors.js';
import { importFromUsb, usbDir } from '#lib/server/usb-import.js';
import type { RequestHandler } from './$types';

export const OPTIONS: RequestHandler = corsPreflight('POST, OPTIONS');

export const POST: RequestHandler = async ({ request }) => {
	const refusal = requireBearer(
		request,
		process.env.AERO_ADMIN_TOKEN,
		'usb import (AERO_ADMIN_TOKEN)'
	);
	const cors = lanCorsHeaders(request.headers.get('origin'));
	if (refusal) return withCors(refusal, cors);

	const result = await importFromUsb();
	return json({ ...result, from: usbDir() }, { headers: cors });
};
