/**
 * The wall: what an operator has pushed to every pane at once. One small JSON
 * document, owned by one Pi's server (`?wall=` points the others at it), polled
 * by every pane. A push carries the second it applies at, LEAD_SEC ahead, so
 * three panes that each notice it within a poll all lower the blind and reload
 * into it on the same second (aero-2's wall snapshot, ADR-007, much reduced).
 *
 * Every field is optional in effect: null means "the default" (follow the
 * rotation, today's weather, the real clock). URL params still win, for dev.
 */
import { PLACES } from '#flight/places.ts';
import { REGIME_NAMES } from '#flight/weather.ts';

export type Push = { place: string | null; weather: string | null; clock: number | null };
export type Wall = Push & { version: number; applyAt: number };

export const NO_WALL: Wall = { version: 0, applyAt: 0, place: null, weather: null, clock: null };
export const LEAD_SEC = 10;

/** Named scenes for /admin, aero-2's presets as wall pushes: one tap fills the form. */
export const PRESETS: Record<string, Push> = {
	'Golden hour': { place: 'dubai', weather: 'fair', clock: 17.6 },
	'Alpine dawn': { place: 'himalayas', weather: 'clear', clock: 6.5 },
	'Gulf midnight': { place: 'dubai', weather: 'clear', clock: 23 },
	'Storm transit': { place: 'mumbai', weather: 'towering', clock: 15 },
	'City lights': { place: 'hyderabad', weather: 'scattered', clock: 21 }
};
export const MAX_PUSH_BYTES = 1024;

/** An operator's push, checked field by field; null if any field is wrong. */
export function parsePush(body: unknown): Push | null {
	if (typeof body !== 'object' || body === null) return null;
	const { place = null, weather = null, clock = null } = body as Record<string, unknown>;
	if (place !== null && !(typeof place === 'string' && Object.hasOwn(PLACES, place))) return null;
	if (weather !== null && !(typeof weather === 'string' && REGIME_NAMES.includes(weather))) return null;
	if (clock !== null && !(typeof clock === 'number' && clock >= 0 && clock <= 24)) return null;
	return { place, weather, clock };
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
