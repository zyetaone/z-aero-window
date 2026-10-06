/**
 * The media store client: what /admin uploads and lists, what the kiosk resolves.
 * IDs are bare store names; only this module turns one into a fetchable URL, and
 * always against the wall origin the pane already polls (server.ts serves the
 * bytes from /media/* there). A pane never resolves against its own origin: that
 * is aero-2's trap (its resolveMediaUrl), the file lives on the uploader.
 */
import { MAX_MEDIA_IDS, MEDIA_ID } from './wall.ts';

/** A bare store name, as the wall carries it. Null when it names no file. */
export function parseMediaId(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const id = value.trim();
	return MEDIA_ID.test(id) ? id : null;
}

/** Split an admin text field ("a.mp3, b.ogg") into at most MAX_MEDIA_IDS clean IDs. */
export function parseIdList(raw: string): string[] {
	const ids: string[] = [];
	for (const part of raw.split(',')) {
		const id = parseMediaId(part);
		if (id && !ids.includes(id)) ids.push(id);
		if (ids.length >= MAX_MEDIA_IDS) break;
	}
	return ids;
}

/**
 * Where a pane fetches an ID. Empty origin means this pane's own server (the wall
 * it follows lives here); otherwise the centre Pi's origin, where the file was
 * uploaded. Already-absolute input is not a store ID and passes through for
 * forward compatibility, never for wall pushes (parsePush rejects it).
 */
export function mediaUrl(origin: string, id: string): string {
	if (/^https?:\/\//.test(id)) return id;
	return `${origin}/media/${encodeURIComponent(id)}`;
}

/** The store listing, or [] when it cannot be had: a pane never waits on it. */
export async function listMedia(origin: string): Promise<string[]> {
	try {
		const res = await fetch(`${origin}/api/media`, { signal: AbortSignal.timeout(2_000) });
		if (!res.ok) return [];
		const { media } = (await res.json()) as { media: unknown };
		return Array.isArray(media) ? media.filter((n): n is string => parseMediaId(n) !== null) : [];
	} catch {
		return [];
	}
}

/** One upload. The token stays in the caller (the /admin form), never in storage. */
export async function uploadMedia(file: File, token: string): Promise<string> {
	const form = new FormData();
	form.append('file', file);
	const res = await fetch('/api/media', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
	if (!res.ok) throw new Error(await res.text());
	const { media } = (await res.json()) as { media: string };
	return media;
}
