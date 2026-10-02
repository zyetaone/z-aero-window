/**
 * Shows registry — time-bucketed rotation across boot openings.
 *
 * Each Pi boot calls `pickDailyShow()` which uses `showRotationSeed()` so:
 *   - All 3 Pis in a panorama pick the SAME show in the same UTC slot
 *   - The pick changes every ROTATION_SLOT_HOURS (not only at midnight)
 *   - Location is NOT restored from localStorage — boot always starts from
 *     the current slot's show; mid-session hops are the autopilot's job
 *
 * Slot length is a multi-Pi trade-off: pure per-boot Math.random() would
 * tear the panorama on staggered reloads; day-only felt stuck. 2 h UTC
 * buckets rotate 12×/day while reloads within a slot stay locked.
 */

import type { Show } from './types';
export type { Show };
import { createSeededRng, daySeed, hashString } from '$lib/world/prng';

import { defaultShow } from './default.show';
import { duskDubaiShow } from './dusk-dubai.show';
import { nightVegasShow } from './night-vegas.show';
import { monsoonMumbaiShow } from './monsoon-mumbai.show';
import { dawnHimalayasShow } from './dawn-himalayas.show';
import { pacificEveningShow } from './pacific-evening.show';
import { middayPhoenixShow } from './midday-phoenix.show';
import { duskDallasShow } from './dusk-dallas.show';
import { nightChicagoShow } from './night-chicago.show';
import { dawnDenverShow } from './dawn-denver.show';

/** How often the boot opening re-rolls (UTC). Shared by all Pis. */
export const ROTATION_SLOT_HOURS = 2;

/** The rotation set — distinct location / weather / time mix. */
export const DAILY_ROTATION: readonly Show[] = [
	defaultShow,           // Hyderabad dawn clear — SWA install brand baseline
	duskDubaiShow,         // Dubai golden hour clear
	nightVegasShow,        // Las Vegas night clear
	monsoonMumbaiShow,     // Mumbai monsoon rain
	dawnHimalayasShow,     // Himalayas alpine dawn
	pacificEveningShow,    // Pacific Ocean sunset
	middayPhoenixShow,     // Phoenix clear noon
	duskDallasShow,        // Dallas golden hour
	nightChicagoShow,      // Chicago night lights
	dawnDenverShow,        // Denver dawn
	// nightCloudsShow stays OUT: hasBuildings:false + deep night = black void
	// without VIIRS/city floor (see night-clouds.show.ts).
	//
	// middayCloudsShow stays OUT FOR THE SAME REASON, which is not obvious from
	// reading it: its opening says timeOfDay 13.0, but a show's authored hour
	// never reaches the fleet. syncToRealTime defaults true and persistence
	// deliberately refuses to restore it ("boot must open with Real Time ON"),
	// so updateTimeFromSystem() overwrites timeOfDay with the real civil hour
	// at the DESTINATION. `clouds` is Asia/Tokyo, and 4 of the 12 two-hour UTC
	// slots land it between 21:00 and 05:00 local — the identical void, reached
	// through the hour instead of through the author.
	//
	// Neither is playable from the fleet today — no URL or admin path resolves
	// them by id; they simply sit out the rotation. Letting either back in
	// needs the pick to
	// be sky-aware (pickNextLocation already scores destination sky; this one
	// does not), or the `clouds` location needs a moonlit floor to be worth
	// looking at after dark.
];

export { defaultShow };

/**
 * Seed for boot-show rendezvous hashing.
 *
 * `daySeed * 100 + slot` — successive 2 h UTC windows get distinct seeds;
 * all devices using wall clock agree on the slot.
 */
export function showRotationSeed(now: Date = new Date()): number {
	const slot = Math.floor(now.getUTCHours() / ROTATION_SLOT_HOURS);
	return daySeed(now) * 100 + slot;
}

/**
 * Pick the show for the current rotation slot (or an injectable seed).
 * Deterministic across Pis for the same seed; content-addressed so adding
 * a show only reassigns the slots that show wins.
 */
export function pickDailyShow(seed: number = showRotationSeed()): Show {
	let best = DAILY_ROTATION[0];
	let bestScore = -1;
	for (const show of DAILY_ROTATION) {
		const score = createSeededRng((seed ^ hashString(show.id)) >>> 0)();
		if (score > bestScore) {
			bestScore = score;
			best = show;
		}
	}
	return best;
}
