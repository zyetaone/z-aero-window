/**
 * The wall: what an operator has pushed to every pane at once. One small JSON
 * document, owned by one Pi's server (`?wall=` points the others at it), polled
 * by every pane. A push carries the second it applies at, LEAD_SEC ahead, so
 * three panes that each notice it within a poll all lower the blind and reload
 * into it on the same second (aero-2's wall snapshot, ADR-007, much reduced).
 *
 * Every field is optional in effect: null means "the default" (follow the
 * rotation, today's weather, the real clock, the pane's own light gains).
 * URL params still win, for dev.
 *
 * Gains (Slice 1): a push may carry the five Lights-panel gains (the per-pane
 * `mix` in main.ts: street/building/far lamp groups, haze, bloom). A pushed
 * gain OVERRIDES that pane's default: it replaces the number, it never
 * multiplies it, and a lone pane's HUD slider still edits the result locally.
 * URL knobs (`?sky= ?lift= ?lamps= ?carpet= ?moonlight= ?contrast= ?clouds=`)
 * stay URL-only: the wall never carries them, so there is no wall-vs-URL
 * conflict to resolve. No pane ever pushes: a push needs AERO_ADMIN_TOKEN,
 * which lives only in the /admin form (server.ts fails closed without it).
 */
import { PLACES } from '#flight/places.ts';
import { REGIME_NAMES } from '#flight/weather.ts';

/** The five per-pane light gains. Ranges mirror the /admin and #lights inputs. */
export type Gains = {
	/** Lamp groups, 0..2 each (the #lights sliders). */
	street: number | null;
	building: number | null;
	far: number | null;
	/** Haze sheet, 0..1. */
	haze: number | null;
	/** Bloom, 0..1. */
	glow: number | null;
};

export const NO_GAINS: Gains = { street: null, building: null, far: null, haze: null, glow: null };

/**
 * Slice 4: what the panes play. Bare store names (/api/media), never URLs:
 * aero-1's 4 KB set_mode trap at our 1024-byte budget means a playlist of URLs
 * blows the wall; eight short IDs fit. Panes resolve each ID against the wall
 * origin they already poll (aero-2's resolveMediaUrl lesson: the file lives on
 * the uploader, never on every pane).
 */
export type Media = { audio: string[]; video: string | null };
export const NO_MEDIA: Media = { audio: [], video: null };
/** At most eight short tracks: the whole push must stay under MAX_PUSH_BYTES. */
export const MAX_MEDIA_IDS = 8;
/** Bare store names (server.ts mediaName): no slashes, audio/video extensions. */
export const MEDIA_ID = /^[A-Za-z0-9][A-Za-z0-9._%-]{0,63}$/;

export type Push = { place: string | null; weather: string | null; clock: number | null; gains: Gains; media: Media };
export type Wall = Push & { version: number; applyAt: number };

export const NO_WALL: Wall = { version: 0, applyAt: 0, place: null, weather: null, clock: null, gains: NO_GAINS, media: NO_MEDIA };
export const LEAD_SEC = 10;

/** Named scenes for /admin, aero-2's presets as wall pushes: one tap fills the form. Gains and media stay default (a preset only fills the form; the operator sets them by hand). */
export const PRESETS: Record<string, Push> = {
	'Golden hour': { place: 'dubai', weather: 'fair', clock: 17.6, gains: { ...NO_GAINS }, media: { audio: [], video: null } },
	'Alpine dawn': { place: 'himalayas', weather: 'clear', clock: 6.5, gains: { ...NO_GAINS }, media: { audio: [], video: null } },
	'Gulf midnight': { place: 'dubai', weather: 'clear', clock: 23, gains: { ...NO_GAINS }, media: { audio: [], video: null } },
	'Storm transit': { place: 'mumbai', weather: 'towering', clock: 15, gains: { ...NO_GAINS }, media: { audio: [], video: null } },
	'City lights': { place: 'hyderabad', weather: 'scattered', clock: 21, gains: { ...NO_GAINS }, media: { audio: [], video: null } }
};
export const MAX_PUSH_BYTES = 1024;

/** One gain: null (default) or a finite number in range; anything else fails the push. */
function parseGain(value: unknown, min: number, max: number): number | null | false {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return false;
	return value;
}

/** One media ID: a bare store name, or false when it is not. */
function parseMediaId(value: unknown): string | null | false {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string' || !MEDIA_ID.test(value)) return false;
	return value;
}

/** An operator's push, checked field by field; null if any field is wrong. */
export function parsePush(body: unknown): Push | null {
	if (typeof body !== 'object' || body === null) return null;
	const { place = null, weather = null, clock = null, gains = null, media = null } = body as Record<string, unknown>;
	if (place !== null && !(typeof place === 'string' && Object.hasOwn(PLACES, place))) return null;
	if (weather !== null && !(typeof weather === 'string' && REGIME_NAMES.includes(weather))) return null;
	if (clock !== null && !(typeof clock === 'number' && clock >= 0 && clock <= 24)) return null;
	if (gains !== null && gains !== undefined && (typeof gains !== 'object' || gains === null || Array.isArray(gains))) return null;
	const g = (gains ?? {}) as Record<string, unknown>;
	const street = parseGain(g.street, 0, 2);
	const building = parseGain(g.building, 0, 2);
	const far = parseGain(g.far, 0, 2);
	const haze = parseGain(g.haze, 0, 1);
	const glow = parseGain(g.glow, 0, 1);
	if (street === false || building === false || far === false || haze === false || glow === false) return null;
	if (media !== null && media !== undefined && (typeof media !== 'object' || media === null || Array.isArray(media))) return null;
	const m = (media ?? {}) as Record<string, unknown>;
	const audio = m.audio ?? [];
	if (!Array.isArray(audio) || audio.length > MAX_MEDIA_IDS) return null;
	const tracks: string[] = [];
	for (const id of audio) {
		const track = parseMediaId(id);
		if (track === false || track === null) return null; // no holes: every entry names a file
		tracks.push(track);
	}
	const video = parseMediaId(m.video);
	if (video === false) return null;
	return { place, weather, clock, gains: { street, building, far, haze, glow }, media: { audio: tracks, video } };
}

/** The wall as `origin` serves it, or NO_WALL if it can't be had in time: a pane never waits on it. */
export async function fetchWall(origin: string, timeoutMs = 2_000): Promise<Wall> {
	try {
		const res = await fetch(`${origin}/api/wall`, { signal: AbortSignal.timeout(timeoutMs) });
		const wall = res.ok ? ((await res.json()) as Wall) : NO_WALL;
		return parsePush(wall) && Number.isFinite(wall.version) && Number.isFinite(wall.applyAt) ? wall : NO_WALL;
	} catch {
		return NO_WALL;
	}
}
