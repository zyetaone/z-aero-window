/**
 * The device's media library, as the admin UI sees it.
 *
 * One module-level store rather than state per picker, because the video list
 * and the audio list are two views of ONE library: a separate fetch per picker
 * would double every request, and an upload through one would leave the other
 * showing a stale listing until it happened to refetch.
 *
 * THE TOKEN IS NEVER PERSISTED. It lives in this module for as long as the tab
 * is open and goes nowhere else — not localStorage, not sessionStorage, not a
 * URL. That is the same rule the on-demand update block in `routes/admin/+page.svelte` follows for the update
 * token, and for the same reason: an admin credential in a browser store on a
 * kiosk-adjacent laptop outlives the operator's attention.
 *
 * `server/` types are imported type-only. The shapes cross the wire as JSON;
 * importing the type costs nothing at runtime and keeps this in step with what
 * `/api/media` actually returns.
 */

import type { MediaItem } from '#lib/server/media-store.js';

class MediaLibrary {
	items = $state.raw<MediaItem[]>([]);
	/** In memory only, for as long as this tab is open. */
	token = $state('');
	loading = $state(false);
	/** Last thing that happened, shown next to whatever button caused it. */
	status = $state('');

	audio = $derived(this.items.filter((m) => m.kind === 'audio'));
	video = $derived(this.items.filter((m) => m.kind === 'video'));

	/** GET is open — no token needed to see what is on the device. */
	async refresh(): Promise<void> {
		this.loading = true;
		try {
			const res = await fetch('/api/media');
			if (!res.ok) {
				this.status = `could not list media (${res.status})`;
				return;
			}
			this.items = ((await res.json()) as { media: MediaItem[] }).media;
		} catch {
			this.status = 'could not reach this device';
		} finally {
			this.loading = false;
		}
	}

	async upload(file: File): Promise<void> {
		if (!this.token) {
			this.status = 'paste the admin token first';
			return;
		}
		const form = new FormData();
		form.append('file', file);
		this.status = `uploading ${file.name}…`;
		try {
			const res = await fetch('/api/media', {
				method: 'POST',
				headers: { authorization: `Bearer ${this.token}` },
				body: form
			});
			const body = await res.json();
			// The server's own message, not a generic one: it distinguishes
			// "too large" from "unsupported type", which is what the operator
			// needs to know to fix it.
			this.status = res.ok ? `added ${file.name}` : `refused: ${body.error ?? res.status}`;
			if (res.ok) await this.refresh();
		} catch {
			this.status = 'upload could not reach this device';
		}
	}

	async importUsb(): Promise<void> {
		if (!this.token) {
			this.status = 'paste the admin token first';
			return;
		}
		this.status = 'reading the drive…';
		try {
			const res = await fetch('/api/media/import-usb', {
				method: 'POST',
				headers: { authorization: `Bearer ${this.token}` }
			});
			const body = await res.json();
			if (!res.ok) {
				this.status = `refused: ${body.error ?? res.status}`;
				return;
			}
			if (!body.mounted) {
				// Not an error. "Nothing in the slot" is the answer, and the
				// operator needs to read it as such rather than as a failure.
				this.status = `no drive at ${body.from}`;
				return;
			}
			const parts = [`${body.imported.length} imported`];
			if (body.alreadyPresent.length) parts.push(`${body.alreadyPresent.length} already here`);
			if (body.skipped.length) parts.push(`${body.skipped.length} skipped`);
			this.status = parts.join(', ');
			await this.refresh();
		} catch {
			this.status = 'import could not reach this device';
		}
	}
}

export const mediaLibrary = new MediaLibrary();

/** Human bytes. Only ever shown, never parsed back. */
export function humanSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
