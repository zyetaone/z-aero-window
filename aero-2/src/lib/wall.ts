/**
 * What the three panes agree on, and nothing else.
 *
 * ADR-007 rejected v1's CRDT: convergence by clock, not convergence by merge.
 * This module is the declarative half of that — the list of keys a wall push
 * may carry. Everything else on `PaneSettings` is pane-state BY OMISSION:
 * never listed here, never touched by the sync machinery, exactly as it behaves
 * today. v1 found this split by hand, one bypass at a time, when `setParallaxRole`
 * had to skip the CRDT stamp because a parallax role is device-local. Declaring
 * it once means the next such field needs no discovery.
 *
 * Lives at `lib/` root, not in `settings/`: `server/` imports nothing from a
 * feature slice (architecture §1) and both sides need this.
 */

import * as z from 'zod';

export const WALL_KEYS = [
	'placeId',
	'presetId',
	'weather',
	'clockOffsetH',
	'displayMode',
	'blindOpen',
	'rotate',
	'mediaUrls',
	'audioUrls'
] as const;

export type WallKey = (typeof WALL_KEYS)[number];

export interface WallState {
	placeId: string;
	presetId: string;
	weather: string;
	clockOffsetH: number;
	displayMode: string;
	blindOpen: boolean;
	rotate: boolean;
	/**
	 * What `video` and `screensaver` mode actually SHOW.
	 *
	 * Without this the wall could push a display mode but not its content: the
	 * only writers of the playlist fields were `?media=` URL params parsed at
	 * boot, so an operator switching the wall to video put "No media specified"
	 * on every pane — a mode switch shipped without the thing it switches to.
	 * The mode and its media travel in one snapshot so they cannot arrive
	 * separately.
	 *
	 * Empty is legal and means "keep whatever the pane booted with", so a wall
	 * that only ever changes flight settings never clobbers a URL-provisioned
	 * playlist.
	 */
	mediaUrls: string[];
	/**
	 * The cabin's soundtrack, travelling with the scene rather than beside it.
	 *
	 * `audioPlaylist` was reachable only through `?audio=` on one pane's URL,
	 * so a song was pane-local and died on reload -- on a wall whose whole
	 * premise is that the three panes are one window. Video already travelled
	 * here as `mediaUrls`; audio had no route at all.
	 *
	 * Same shape and same cap as `mediaUrls`, and validated by the same schema:
	 * path-absolute or http(s), so an uploaded `/api/media/<hash>.mp3` passes
	 * and a `javascript:` or `data:` URL does not.
	 */
	audioUrls: string[];
}

/** One push. `version` and `applyAtWallSec` are the server's to set, never a client's. */
export interface WallSnapshot {
	/**
	 * Ordering is a monotonic integer, not a timestamp. v1 ordered by wall clock
	 * and therefore needed a sanity floor against a Pi whose NTP had not settled;
	 * an integer the single writer increments has no such failure mode.
	 */
	version: number;
	/** The wall second at which every pane applies this, together. */
	applyAtWallSec: number;
	state: WallState;
}

/** Closed sets the server is allowed to know. See `parseWallState`. */
const WEATHERS = ['clear', 'cloudy', 'rain', 'overcast', 'storm'] as const;
export const DISPLAY_MODES = ['flight', 'video', 'screensaver', 'standby'] as const;
const CLOCK_OFFSET_RANGE: readonly [number, number] = [-12, 12];

/**
 * A bounded list of same-origin-or-http(s) media paths.
 *
 * Bounded twice — 12 entries, 300 chars each — because this crosses the wire
 * into a file the server rewrites and every pane polls; MAX_WALL_BYTES is the
 * backstop, not the policy. Only path-absolute (`/cabin.mp4`) and http(s) URLs
 * pass: a `javascript:` or `data:` URL in a `<video src>` is inert in modern
 * browsers, but "inert in modern browsers" is not a contract worth shipping on
 * a kiosk that runs one browser build for years. Rejected, not filtered — a
 * push with one bad URL should fail loudly at the admin's screen, not land
 * quietly minus a track nobody noticed was dropped.
 */
/**
 * Transport bound on a pushed snapshot, in bytes.
 *
 * Lives HERE, beside the schema bounds, and not in the route that enforces it.
 * Two reasons, and the second cost a production 500:
 *
 * 1. It only means anything against the bounds above -- a cap nobody measures
 *    against the schema is the bug it had: tuned by hand to one 12x300 list
 *    with 254 bytes spare, then `audioUrls` made a schema-legal push 7,488
 *    bytes, accepted by the parser and refused by the transport with a 413.
 *
 * 2. SvelteKit refuses any non-handler export from a `+server.ts`. Exporting
 *    it from the route so a test could read it turned every POST /api/wall
 *    into a 500 -- on the ONE endpoint that changes all three panes at once.
 *    `svelte-check` was green and the unit test passed, because the test
 *    imported the module directly and never asked SvelteKit to accept it.
 */
export const MAX_WALL_BYTES = 16 * 1024;

export const MAX_MEDIA_URL_CHARS = 300;

/** Per list. Two lists, so a worst-case snapshot carries 24 URLs. */
export const MAX_PLAYLIST_ENTRIES = 12;

/** `placeId` and `presetId`. */
export const MAX_ID_CHARS = 64;

const mediaUrlSchema = z
	.string()
	.min(1)
	.max(MAX_MEDIA_URL_CHARS)
	.refine((u) => /^(\/[^/]|https?:\/\/)/.test(u));

/** Empty string is legal — it means "no preset pinned". */
const idSchema = z
	.string()
	.max(MAX_ID_CHARS)
	.refine((s) => s === '' || /^[a-z0-9][a-z0-9-]*$/.test(s));

/**
 * Validate an untrusted body into a `WallState`, or null.
 *
 * `placeId` and `presetId` are checked as bounded identifier-shaped strings
 * rather than against the catalogs, deliberately: the catalogs live in
 * `settings/`, which `server/` must not import, and the client already resolves
 * an unknown id through `Location.byId`'s documented fallback. The server's job
 * here is to reject junk and cap size, not to own the catalog.
 *
 * A push is a whole snapshot — the object schema below requires every
 * WALL_KEY, so a partial write fails closed. Per-field patches are the thing
 * ADR-007 says not to build: a partial write needs a merge rule, and a merge
 * rule is the CRDT growing back. Unknown keys are stripped, never stored.
 */
const wallStateSchema = z.object({
	placeId: idSchema,
	presetId: idSchema,
	weather: z.enum(WEATHERS),
	displayMode: z.enum(DISPLAY_MODES),
	blindOpen: z.boolean(),
	rotate: z.boolean(),
	clockOffsetH: z.number().finite().min(CLOCK_OFFSET_RANGE[0]).max(CLOCK_OFFSET_RANGE[1]),
	mediaUrls: z.array(mediaUrlSchema).max(MAX_PLAYLIST_ENTRIES),
	audioUrls: z.array(mediaUrlSchema).max(MAX_PLAYLIST_ENTRIES)
});

/**
 * A media URL from a snapshot, made fetchable by the pane that received it.
 *
 * WHY: a stored URL is root-relative (`/api/media/<hash>.mp3`), and a browser
 * resolves that against the PANE's own origin. But the file was uploaded to the
 * wall writer -- the single origin `PUBLIC_WALL_ORIGIN` names and all three
 * panes poll. So a track uploaded on the writer 404s on the other two, which is
 * the state the upload path shipped in.
 *
 * The host that served the snapshot is, by construction, the host holding the
 * file, so the poll origin is the right base and no second env var is needed.
 * Absolute URLs pass through untouched: a CDN playlist is already addressed.
 *
 * Note for whoever points a wall at a peer: CSP `media-src` is baked at BUILD
 * time from `AERO_MEDIA_ORIGINS` (`vite.config.ts`). A cross-origin media URL
 * with no matching directive fails SILENTLY -- no error, no sound. The origin
 * has to be in both places.
 */
export function resolveMediaUrl(url: string, origin: string): string {
	if (!origin || !url.startsWith('/')) return url;
	return `${origin.replace(/\/$/, '')}${url}`;
}

/**
 * The inverse, for reading a resolved URL back out of a pane's config.
 *
 * `resolveMediaUrl` is one-way per snapshot, but the drawer seeds its push
 * draft from the config the LAST snapshot wrote -- so without this, a pane
 * following a peer seeds absolute URLs, the picker (which matches against the
 * listing's relative `url`) shows every playing track as "not on this device",
 * and the next push writes absolute URLs into `wall.json`. That is exactly the
 * origin-free invariant `resolveMediaUrl` exists to preserve, broken by its own
 * output one round-trip later.
 *
 * Only this wall's own origin is stripped. A genuine CDN URL is not ours to
 * rewrite and passes through.
 */
export function unresolveMediaUrl(url: string, origin: string): string {
	const base = origin.replace(/\/$/, '');
	if (!base || !url.startsWith(`${base}/`)) return url;
	return url.slice(base.length);
}

/**
 * The push draft's media seed, as a function so a test can hold the real one.
 *
 * `Wall.svelte` seeds from the config the last snapshot wrote, and both halves
 * matter: `applyWallState` splits one `mediaUrls` list into clips and stills,
 * so seeding from `videoPlaylist` alone silently drops every still, and an
 * extensionless URL lands in both lists and would otherwise seed twice.
 *
 * Lives here rather than inline in the component because the defect it guards
 * is entirely about URLs, and a component test would need a DOM to reach it.
 */
export function seedMediaDraft(lists: readonly (readonly string[])[], origin: string): string[] {
	return [...new Set(lists.flat().map((u) => unresolveMediaUrl(u, origin)))];
}

/** Extensions a `<video>` can play. Anything else in a media list is a still. */
const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.m4v', '.ogv'];

/**
 * Split one media list into the two things it feeds.
 *
 * `video` mode renders a `<video>`; `screensaver` renders an `<img>`. Both used
 * to be handed the SAME list, so an `.mp4` pushed to a pane sitting in
 * screensaver mode landed in an `<img src>` and rendered the failure pane. One
 * list, two element types, no test that could tell them apart.
 *
 * An unknown extension goes to BOTH, preserving the old behaviour for URLs we
 * cannot classify -- a remote URL with no extension is not evidence of a still.
 */
export function splitMediaByKind(urls: readonly string[]): {
	videos: string[];
	stills: string[];
} {
	const videos: string[] = [];
	const stills: string[] = [];
	for (const u of urls) {
		const path = u.split(/[?#]/)[0].toLowerCase();
		const dot = path.lastIndexOf('.');
		const ext = dot === -1 ? '' : path.slice(dot);
		const known = ext !== '' && /^\.[a-z0-9]{2,5}$/.test(ext);
		if (!known) {
			videos.push(u);
			stills.push(u);
		} else if (VIDEO_EXTS.includes(ext)) {
			videos.push(u);
		} else {
			stills.push(u);
		}
	}
	return { videos, stills };
}

export function parseWallState(input: unknown): WallState | null {
	const parsed = wallStateSchema.safeParse(input);
	if (!parsed.success) return null;
	return parsed.data;
}
