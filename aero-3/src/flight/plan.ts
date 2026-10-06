/**
 * The visit: everything this pane decides once, at boot, for its 10-minute slot — where, which
 * flight, today's weather, which row, how the pane is turned. Pure: the URL (params.ts), the
 * operator's wall (ops/wall.ts) and the boot second in, one plain object out. Every input but the
 * pane's role is the same on all three panes, so they agree without talking.
 */
import type { Wall } from '#ops/wall.ts';
import { hash, RAD } from '#math.ts';
import { weatherFor } from './weather.ts';
import { pathFor } from './path.ts';
import type { Params } from './params.ts';
import { destinationAt, DWELL_SEC, PLACES, slotAt } from './places.ts';

const ORBIT_M = 9000;
// The outer two panes look 24° off the centre (aero-2's parallax); ?yaw= sets it exactly.
const ROLE_YAW: Record<string, number> = { left: -24, right: 24 };

export const SEATS = ['behind', 'over', 'ahead'] as const;
export type Seat = (typeof SEATS)[number];
/** A row from a 0..1 draw: behind the wing half the time, over it a third, ahead of it the rest. */
export const seatFor = (u: number): Seat => (u < 0.5 ? 'behind' : u < 0.83 ? 'over' : 'ahead');

export function planFlight(P: Params, wall: Wall, nowMs: number) {
	// ?place= (or the wall) pins a city; otherwise the wall-clock rotation picks it.
	const asked = P.place ?? wall.place;
	const pinnedPlace = asked && Object.hasOwn(PLACES, asked) ? asked : null;
	const slot = slotAt(nowMs / 1000);
	const placeId = pinnedPlace ?? destinationAt(nowMs / 1000);
	const [lat, lon, groundM, orbitM = ORBIT_M] = PLACES[placeId]!;
	return {
		slot,
		placeId,
		pinnedPlace,
		lat,
		lon,
		groundM,
		track: pathFor(Math.floor(hash(slot * 0x2545f491 + groundM) * 2 ** 31), orbitM),
		// Today for this place, from the slot's start: the same on every pane, different tomorrow.
		weather: weatherFor(placeId, slot * DWELL_SEC * 1000, P.weather ?? wall.weather),
		seat: (SEATS as readonly string[]).includes(P.seat ?? '') ? (P.seat as Seat) : seatFor(hash(slot * 0x9e3779b1 + 7)),
		paneYaw: (P.yaw ?? (P.role ? (ROLE_YAW[P.role] ?? 0) : 0)) * RAD,
		/** The pinned solar hour, or null to follow the real sun. */
		clock: Number.isNaN(P.clock) ? wall.clock : P.clock
	};
}

export type FlightPlan = ReturnType<typeof planFlight>;
