/**
 * Stream-limited body readers.
 *
 * Bytes are counted as they arrive and the read is abandoned the moment the cap
 * is exceeded, so an oversized payload is rejected mid-stream and never fully
 * buffered into process memory. Counting actual bytes rather than trusting
 * `Content-Length` also covers chunked transfer encoding, where the header is
 * absent or a lie.
 *
 * Returns a discriminated result rather than throwing, for the same reason as
 * `auth.ts`: a handler is callable from a test with a bare `Request`.
 */

export type BodyResult<T> = { ok: true; value: T } | { ok: false; response: Response };

/** Read up to `maxBytes` from a stream. Fails with 413 the moment the cap is passed. */
export async function readLimited(
	stream: ReadableStream<Uint8Array> | null,
	maxBytes: number
): Promise<BodyResult<Uint8Array>> {
	if (!stream) return fail(400, 'missing request body');

	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			if (received > maxBytes) {
				/**
				 * Stop reading, but do NOT cancel the stream.
				 *
				 * This was `await reader.cancel()`, on the reasoning that cancelling
				 * tells the sender to stop rather than reading it to completion. The
				 * reasoning is sound and the mechanism backfires: adapter-node builds
				 * the body as a ReadableStream whose `cancel` is
				 * `req.destroy(reason)`, so cancelling destroys the SOCKET — and the
				 * 413 we return next has nowhere to be written. Measured over real
				 * HTTP, an over-limit POST got an empty `200` with `Connection:
				 * close`, on this route and on `/api/wall`, which had shipped that way.
				 *
				 * Do not "simplify" this back to `cancel()` now that the app runs on
				 * adapter-bun instead of adapter-node: `releaseLock()` is correct under
				 * any adapter, while `cancel()` was only safe under the one it was
				 * measured on. The wire-level 413 is asserted in
				 * tools/smoke-routes.mjs and was re-verified against the Bun server,
				 * which is the check that would catch it if this ever stopped holding.
				 *
				 * A unit test cannot see it. A bare `new Request(...)` has no socket
				 * to destroy, so the handler returns a clean 413 and the suite is
				 * green while the wire says 200. That gap is why this is verified with
				 * curl against a built server, not only with vitest.
				 *
				 * Releasing the lock instead leaves the stream intact, which is what
				 * makes the 413 reachable at all. What happens to the CONNECTION
				 * afterwards differs by adapter, and both were measured over real HTTP:
				 *
				 *   adapter-node  drains the unread remainder once the response is
				 *                 written, so the connection stays reusable.
				 *   adapter-bun   answers `Connection: close` and drops it. Control:
				 *                 two ordinary requests DO report `Re-using existing
				 *                 connection`; the request after a 413 opens a new one.
				 *
				 * Closing is not a regression — you cannot reuse a connection whose
				 * request body is still unread, so not draining and not reusing are the
				 * same decision reached two ways, and closing avoids reading another
				 * 700 KB of a payload we have already rejected. The requirement here is
				 * only that the STATUS be truthful, and that holds under both. The bytes
				 * already read are dropped either way.
				 *
				 * The `finally` below releases too, which is fine: a second
				 * `releaseLock()` on an already-released reader is a documented no-op,
				 * verified rather than assumed.
				 */
				reader.releaseLock();
				return fail(413, `request body too large: >${received} bytes, limit is ${maxBytes}`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const out = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true, value: out };
}

/** Read up to `maxBytes` from `request.body` and parse as JSON. */
export async function readLimitedJson<T>(
	request: Request,
	maxBytes: number
): Promise<BodyResult<T>> {
	const bytes = await readLimited(request.body, maxBytes);
	if (!bytes.ok) return bytes;

	try {
		return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes.value)) as T };
	} catch {
		return fail(400, 'invalid JSON');
	}
}

function fail(status: number, message: string): { ok: false; response: Response } {
	return {
		ok: false,
		response: new Response(JSON.stringify({ error: message }), {
			status,
			headers: { 'content-type': 'application/json' }
		})
	};
}
