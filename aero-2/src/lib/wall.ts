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
const DISPLAY_MODES = ['flight', 'video', 'screensaver', 'standby'] as const;
const CLOCK_OFFSET_RANGE: readonly [number, number] = [-12, 12];

/**
 * Validate an untrusted body into a `WallState`, or null.
 *
 * `placeId` and `presetId` are checked as bounded identifier-shaped strings
 * rather than against the catalogs, deliberately: the catalogs live in
 * `settings/`, which `server/` must not import, and the client already resolves
 * an unknown id through `Location.byId`'s documented fallback. The server's job
 * here is to reject junk and cap size, not to own the catalog.
 *
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
const mediaUrlSchema = z
	.string()
	.min(1)
	.max(300)
	.refine((u) => /^(\/[^/]|https?:\/\/)/.test(u));

/** Empty string is legal — it means "no preset pinned". */
const idSchema = z
	.string()
	.max(64)
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
	mediaUrls: z.array(mediaUrlSchema).max(12),
	audioUrls: z.array(mediaUrlSchema).max(12)
});

export function parseWallState(input: unknown): WallState | null {
	const parsed = wallStateSchema.safeParse(input);
	if (!parsed.success) return null;
	return parsed.data;
}
