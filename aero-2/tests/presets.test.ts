import { describe, it, expect } from 'vitest';
import { SCENE_PRESETS } from '#lib/settings/presets.js';
import { PaneSettings } from '#lib/settings/settings.svelte.js';
import { localHourAtSunElevation, resolveLocalHours, sunPosition } from '#lib/display/world/sun.js';
import { Location } from '#lib/locations.js';

describe('Scene Composition Presets', () => {
	it('defines all required preset metadata and config fields', () => {
		expect(SCENE_PRESETS.length).toBeGreaterThan(3);
		for (const preset of SCENE_PRESETS) {
			expect(preset.id).toBeTruthy();
			expect(preset.name).toBeTruthy();
			expect(preset.icon).toBeTruthy();
			expect(preset.badge).toBeTruthy();
			expect(preset.config).toBeDefined();
		}
	});

	it('successfully applies preset to PaneSettings instance', () => {
		const settings = new PaneSettings();
		settings.applyPreset('gulf-midnight', 0);
		expect(settings.place.id).toBe('dubai');
		expect(settings.weather).toBe('rain');
	});

	it('gracefully handles unknown preset ids', () => {
		const settings = new PaneSettings();
		const initialPlace = settings.place.id;
		settings.applyPreset('nonexistent-preset', 0);
		expect(settings.place.id).toBe(initialPlace);
	});

	/**
	 * The presets were authored as `clockOffsetH: 12.0, // midnight darkness`.
	 * clockOffsetH is a DELTA from real local time, so that scene was midnight
	 * only when the real local hour happened to be noon, and drifted hour by
	 * hour on a kiosk that runs all day. Every card's lighting claim was
	 * coincidental. Sampling around the clock is the whole point of the test.
	 */
	it('lands on the authored local hour whatever time it really is', () => {
		for (const preset of SCENE_PRESETS) {
			const want = preset.config.localHour;
			if (want === undefined) continue;
			/**
			 * Presets that name a SUN ELEVATION are excluded, because for those the
			 * authored hour is only the polar fallback and being overridden is the
			 * correct behaviour — see "a preset that promises a light" below, which
			 * is the stronger claim for exactly those presets.
			 *
			 * Scoping this rather than deleting it: the property still matters for
			 * `gulf-midnight`, where midnight really is a time of day.
			 */
			if (preset.config.sunElevationDeg !== undefined) continue;

			for (let hour = 0; hour < 24; hour += 3) {
				const wallSec = 1_787_650_000 - (1_787_650_000 % 86_400) + hour * 3600;
				const s = new PaneSettings();
				s.applyPreset(preset.id, wallSec);

				const got = resolveLocalHours(wallSec, s.place.utcOffset + s.clockOffsetH);
				const diff = (((got - want) % 24) + 24) % 24;
				const circular = Math.min(diff, 24 - diff);
				// 15-minute grid, so 0.125 h is the worst honest miss.
				expect(circular, `${preset.id} at real hour ${hour}`).toBeLessThan(0.2);
			}
		}
	});

	/**
	 * `rain?: boolean` could not express the other three conditions, so the
	 * storm preset resolved to 'rain': turbulence 0.38 instead of 1.0, rain
	 * glass 0.72 instead of 1, and no lightning at all.
	 */
	it('lets a storm preset actually be a storm', () => {
		const s = new PaneSettings();
		s.applyPreset('storm-transit', 0);
		expect(s.weather).toBe('storm');
	});

	it('names a place the card would recognise', () => {
		for (const preset of SCENE_PRESETS) {
			const s = new PaneSettings();
			s.applyPreset(preset.id, 0);
			expect(preset.config.placeId, preset.id).toBe(s.place.id);
		}
	});

	/** /admin links every preset as `/?preset=<id>`; nothing parsed the param. */
	it('is reachable from the URL, which is how /admin links it', () => {
		for (const preset of SCENE_PRESETS) {
			const s = new PaneSettings();
			s.applyUrl(new URL(`http://localhost/?preset=${preset.id}`));
			expect(s.place.id, preset.id).toBe(preset.config.placeId);
		}
	});
});

describe('a preset that promises a light delivers it all year', () => {
	/**
	 * An hour holds all day but not all YEAR.
	 *
	 * `golden-hour` was authored `localHour: 18.25, // low amber sun, just
	 * before the horizon`. Sunset at Las Vegas moves about three hours between
	 * June and December, so measured across a year that preset ranged from
	 * +10.5 deg (mid-afternoon) to -15.2 deg (full night, well past civil
	 * twilight) — a correct sunset for roughly four months and pitch dark from
	 * October to February, on a kiosk that runs every day of the year.
	 *
	 * This is the same class of bug `localHour` itself was introduced to fix.
	 * The presets were originally `clockOffsetH` deltas, correct only when the
	 * real local hour happened to match; `localHour` fixed the time-of-day
	 * dependency and left the time-of-YEAR one. A preset whose promise is the
	 * QUALITY of the light has to name the light.
	 */
	const SAMPLES: number[] = [];
	for (let d = 0; d < 365; d += 11)
		for (const h of [0, 5, 11, 17]) SAMPLES.push(1780000000 + d * 86400 + h * 3600);

	/**
	 * Keyed off the PRESET ID, not off `config.sunElevationDeg`.
	 *
	 * Filtering on the field meant deleting the field also deleted the test:
	 * reverting `golden-hour` to its authored hour made this suite report
	 * "9 skipped, 1 passed" instead of going red. A test that disappears when
	 * the fix is removed does not protect the fix — it protects the mechanism,
	 * which is not what was promised. These ids are named because their CARDS
	 * make a claim about the light, and that claim has to survive whatever
	 * mechanism is used to deliver it.
	 */
	const LIGHT_CLAIMS: Record<string, number> = {
		'golden-hour': 4,
		'alpine-ridge': 15
	};

	for (const [id, want] of Object.entries(LIGHT_CLAIMS)) {
		it(`${id} holds its sun elevation across the year`, () => {
			const preset = SCENE_PRESETS.find((p) => p.id === id);
			expect(preset, `${id} is missing from the catalogue`).toBeTruthy();
			const loc = Location.byId(preset!.config.placeId ?? '');
			for (const wallSec of SAMPLES) {
				const s = new PaneSettings();
				s.applyPreset(preset!, wallSec);
				const got = sunPosition(wallSec, loc.lat, loc.utcOffset + s.clockOffsetH).elevationDeg;
				// 2.5 deg covers the 15-minute quantisation of clockOffsetH, which is
				// up to 6 minutes of error and steepest near the horizon.
				expect(
					Math.abs(got - want),
					`${id} at wallSec ${wallSec}: wanted ${want} deg, got ${got.toFixed(1)}`
				).toBeLessThan(2.5);
			}
		});
	}

	/**
	 * The polar case is real for this catalogue — the Himalayas sit at 28 N, but
	 * the mechanism has to be safe for any latitude someone adds later. Above
	 * the Arctic circle in midsummer the sun never reaches -6, so there is no
	 * hour to solve for and the authored clock hour has to win.
	 */
	it('falls back to the clock hour when the sun never reaches the angle', () => {
		expect(localHourAtSunElevation(-6, 1780000000 + 172 * 86400, 78, true)).toBeNull();
		expect(localHourAtSunElevation(45, 1780000000 + 355 * 86400, 78, true)).toBeNull();
		// And a reachable one still resolves.
		expect(localHourAtSunElevation(4, 1780000000, 36.17, true)).not.toBeNull();
	});

	it('rising and evening are different sides of solar noon', () => {
		const t = 1780000000;
		// The flag is `evening`, so `false` is the morning solution.
		const evening = localHourAtSunElevation(15, t, 28, true);
		const rising = localHourAtSunElevation(15, t, 28, false);
		expect(rising).not.toBeNull();
		expect(evening).not.toBeNull();
		expect(rising!).toBeLessThan(12);
		expect(evening!).toBeGreaterThan(12);
	});
});
