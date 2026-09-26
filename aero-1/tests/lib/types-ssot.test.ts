/**
 * Const-array SSOT coverage.
 *
 * WEATHER_TYPES / DISPLAY_MODES / DEVICE_ROLES / QUALITY_MODES are the single
 * source for both the TS union and the runtime guard. The failure mode these
 * pin is a UI that re-lists the members by hand: the admin panel used to carry
 * its own copy of the five weather types, so adding a sixth would have left the
 * admin offering a different set than the kiosk it drives, with nothing failing.
 */
import { describe, it, expect } from 'vitest';
import {
	WEATHER_TYPES,
	DISPLAY_MODES,
	DEVICE_ROLES,
	QUALITY_MODES,
	DISPLAY_MODE_LABELS,
	isValidWeather,
	isValidDisplayMode,
	isValidDeviceRole,
	isValidQualityMode,
} from '$lib/types';

const SETS = [
	['WEATHER_TYPES', WEATHER_TYPES, isValidWeather],
	['DISPLAY_MODES', DISPLAY_MODES, isValidDisplayMode],
	['DEVICE_ROLES', DEVICE_ROLES, isValidDeviceRole],
	['QUALITY_MODES', QUALITY_MODES, isValidQualityMode],
] as const;

describe('const-array SSOTs', () => {
	it.each(SETS.map(([n, a, g]) => [n, a, g]))(
		'%s: every member passes its own guard',
		(_name, arr, guard) => {
			for (const v of arr as readonly string[]) expect(guard(v)).toBe(true);
		},
	);

	it.each(SETS.map(([n, , g]) => [n, g]))(
		'%s guard rejects non-members and non-strings',
		(_name, guard) => {
			for (const bad of ['', 'nope', '__proto__', 'constructor', 0, null, undefined, {}, []]) {
				expect(guard(bad)).toBe(false);
			}
		},
	);

	it.each(SETS.map(([n, a]) => [n, a]))('%s has no duplicate members', (_name, arr) => {
		const a = arr as readonly string[];
		expect(new Set(a).size).toBe(a.length);
	});

	// The guard must be derived from the array, not a parallel hand-written
	// list — otherwise the two drift and a "valid" value fails validation.
	it('guards reject a value that looks plausible but is not in the array', () => {
		expect(isValidWeather('sunny')).toBe(false);        // plausible, not a member
		expect(isValidDeviceRole('centre')).toBe(false);    // British spelling
		expect(isValidDisplayMode('photo')).toBe(false);
		expect(isValidQualityMode('high')).toBe(false);     // not our vocabulary
	});

	// DISPLAY_MODE_LABELS must cover every mode with both lengths — the admin
	// used to carry two sibling maps (buttons vs cards) that drifted apart.
	it('DISPLAY_MODE_LABELS covers every mode, short and long', () => {
		for (const mode of DISPLAY_MODES) {
			expect(DISPLAY_MODE_LABELS[mode].short.length).toBeGreaterThan(0);
			expect(DISPLAY_MODE_LABELS[mode].long.length).toBeGreaterThan(0);
		}
		expect(Object.keys(DISPLAY_MODE_LABELS).sort()).toEqual([...DISPLAY_MODES].sort());
	});
});
