/**
 * Location catalog and lookup for fielded kiosks and simulation targets.
 */

/**
 * UTC offset in hours for an IANA zone at a given instant, DST included.
 *
 * The offset used to be typed in by hand beside the zone name, and it was
 * wrong: Denver carried -7 while `America/Denver` is -6 from March to November,
 * so for two thirds of the year that kiosk's clock, night curve, sun position
 * and hillshade bearing were all an hour out. Six of the twelve places below
 * observe DST, so hand-typed offsets would be wrong somewhere for most of the
 * year. The zone string was already stored and already unused; this derives the
 * number from it instead of duplicating it.
 *
 * Determinism holds: every Pi resolves the same zone at the same instant from
 * the same tz database, so all three agree.
 */
function offsetHoursFor(timeZone: string, atMs: number): number {
	const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
		.formatToParts(new Date(atMs))
		.find((p) => p.type === 'timeZoneName')?.value;
	// "GMT-06:00", "GMT+05:30", or plain "GMT" at exactly zero.
	const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name ?? '');
	if (!m) return 0;
	return (m[1] === '-' ? -1 : 1) * (Number(m[2]) + Number(m[3] ?? 0) / 60);
}

/** (zone, hour-bucket) -> offset. Intl.DateTimeFormat is slow; the answer
 *  cannot change inside one hour, and this is read every frame. */
const offsetCache = new Map<string, number>();

function offsetHoursNow(timeZone: string, atMs: number = Date.now()): number {
	const hourBucket = Math.floor(atMs / 3_600_000);
	const key = `${timeZone}@${hourBucket}`;
	const hit = offsetCache.get(key);
	if (hit !== undefined) return hit;
	const value = offsetHoursFor(timeZone, atMs);
	if (offsetCache.size > 64) offsetCache.clear();
	offsetCache.set(key, value);
	return value;
}

/**
 * A place you orbit and look at, versus terrain you cross.
 *
 * The difference is not cosmetic: `city` drives the inward-facing camera, which
 * is meaningless over open ocean.
 */
export type LocationKind = 'city' | 'feature';

export class Location {
	constructor(
		readonly id: string,
		readonly name: string,
		readonly lat: number,
		readonly lon: number,
		readonly timeZone: string,
		/** Mean terrain height, metres MSL. */
		readonly groundElevationM: number,
		/** Climb envelope, metres ABOVE GROUND. Floor must clear local peaks. */
		readonly climbFloorM: number,
		readonly climbCeilingM: number,
		/**
		 * What kind of place this is, which changes how the window behaves.
		 *
		 * `city` has a centre worth looking AT — the orbit circles it and the
		 * camera aims inward, so the skyline stays in frame for the whole loop.
		 *
		 * `feature` is terrain: the Himalayas, open ocean, open desert. There is
		 * no centre to orbit and nothing to point at, so aiming inward just
		 * stares at one arbitrary patch of ground for 49 minutes. These read as
		 * mid-transit — you are crossing them, not visiting them — so the camera
		 * looks along the track instead.
		 */
		readonly kind: LocationKind = 'city'
	) {}

	get isFeature(): boolean {
		return this.kind === 'feature';
	}

	/**
	 * Hours ahead of UTC right NOW, DST included. Derived, never typed in.
	 *
	 * A getter, not a field set in the constructor. CATALOG is a static built
	 * once at module load, so a cached offset freezes whatever DST state the
	 * process started in: a kiosk booted in January would still claim -07:00 for
	 * Denver in July, putting the sun an hour out until someone restarted it.
	 * Six of the eleven locations shift across DST.
	 *
	 * Cheap enough to call per frame — it feeds `sunPosition` and time-of-day —
	 * but memoised per (zone, hour) because `Intl.DateTimeFormat` is not free
	 * and the answer cannot change within an hour.
	 */
	get utcOffset(): number {
		return offsetHoursNow(this.timeZone);
	}

	/**
	 * The catalog, carried over from v1's `content/locations/catalog.ts`.
	 *
	 * A flat list rather than one static factory per place: twelve near-identical
	 * factories is the shape that invites a thirteenth to be added in one place
	 * and forgotten in another. `byId` and `all` read this and nothing else.
	 *
	 * `climbFloorM` is metres ABOVE GROUND and has to clear the local high
	 * ground, because the camera flies at floor + terrain. Denver needs 3,000 m
	 * for the Front Range and the Himalayas 3,500 for the obvious reason; a
	 * coastal city does not.
	 *
	 * The envelopes are deliberately NOT uniform. Identical 400..13,000 for
	 * every place made every location fly the same profile and read as the same
	 * flight over different wallpaper. Ocean sits low and stays low, Denver and
	 * the Himalayas start high because they must, and the rest are spread
	 * between — so the altitude band, and with it the atmosphere the window
	 * sees, differs by where you are.
	 *
	 * Tokyo ("Above Clouds" in v1) is deliberately absent.
	 */
	static readonly CATALOG: readonly Location[] = [
		//         id                name                     lat        lon        IANA zone              ground  floor  ceiling
		new Location(
			'hyderabad',
			'Hyderabad, India',
			17.4435,
			78.3772,
			'Asia/Kolkata',
			500,
			400,
			12_500
		),
		new Location('mumbai', 'Mumbai, India', 19.076, 72.8777, 'Asia/Kolkata', 10, 500, 12_000),
		new Location('dubai', 'Dubai, UAE', 25.2048, 55.2708, 'Asia/Dubai', 5, 600, 13_000),
		new Location('dallas', 'Dallas, Texas', 32.7767, -96.797, 'America/Chicago', 150, 700, 12_000),
		new Location(
			'phoenix',
			'Phoenix, Arizona',
			33.4352,
			-112.0101,
			'America/Phoenix',
			340,
			800,
			12_500
		),
		new Location(
			'las_vegas',
			'Las Vegas, Nevada',
			36.1699,
			-115.1398,
			'America/Los_Angeles',
			620,
			900,
			12_800
		),
		new Location(
			'denver',
			'Denver, Colorado',
			39.8561,
			-104.6737,
			'America/Denver',
			1_600,
			3_000,
			13_000
		),
		new Location(
			'chicago_midway',
			'Chicago Midway',
			41.7868,
			-87.7522,
			'America/Chicago',
			190,
			650,
			11_500
		),
		/**
		 * The floor clears Everest, because the camera flies at floor + ground.
		 *
		 * 3,500 AGL over a 5,000 m mean put the camera at 8,500 m -- 349 m BELOW
		 * the 8,849 m summit -- so at the bottom of the climb the window filled
		 * with rock. 4,600 (9,600 MSL) cleared the rock but left only 750 m
		 * over the summit, and none at all against an exaggerated draw. 6,000
		 * puts the band at 11,000 MSL: airliner crossing levels, comfortable
		 * margin over the real summit, headroom for the alpine-ridge relief.
		 */
		new Location(
			'himalayas',
			'The Himalayas',
			27.9881,
			86.925,
			'Asia/Kathmandu',
			5_000,
			6_000,
			13_000,
			'feature'
		),
		new Location(
			'ocean',
			'Pacific Ocean',
			21.3069,
			-157.8583,
			'Pacific/Honolulu',
			0,
			300,
			11_000,
			'feature'
		),
		new Location(
			'desert',
			'Sahara Desert',
			23.4241,
			25.6628,
			'Africa/Cairo',
			500,
			700,
			12_500,
			'feature'
		)
	];

	/**
	 * Per-place atmosphere character: how dusty the air reads by day, and how
	 * hard the city lights hit at night. Render-path multipliers, NEVER config
	 * writes — the operator's knobs keep meaning what they say, and every pane
	 * on a wall derives the same mood from the same place id, so the panorama
	 * cannot split. A place missing here gets the default, openly.
	 */
	static moodFor(id: string): PlaceMood {
		return PLACE_MOODS[id] ?? DEFAULT_MOOD;
	}

	/** The fielded kiosk home, and the fallback for anything unrecognised. */
	static hyderabad(): Location {
		return Location.CATALOG[0];
	}

	static denver(): Location {
		return Location.byId('denver');
	}

	static byId(id: string | null | undefined): Location {
		return Location.CATALOG.find((l) => l.id === id) ?? Location.hyderabad();
	}

	static isValid(id: string | null | undefined): boolean {
		return Location.CATALOG.some((l) => l.id === id);
	}

	static all(): readonly Location[] {
		return Location.CATALOG;
	}

	/** Places with a centre worth orbiting. */
	static cities(): readonly Location[] {
		return Location.CATALOG.filter((l) => l.kind === 'city');
	}

	/** Terrain you cross rather than visit. */
	static features(): readonly Location[] {
		return Location.CATALOG.filter((l) => l.kind === 'feature');
	}
}

export interface PlaceMood {
	/** Daytime dust in the air: 0 crisp alpine, ~0.4 Saharan dust. */
	dust: number;
	/** Night-light gain: showcase cities above 1, sleeping desert below. */
	nightGlow: number;
}

const DEFAULT_MOOD: PlaceMood = { dust: 0.1, nightGlow: 1.0 };

const PLACE_MOODS: Record<string, PlaceMood> = {
	hyderabad: { dust: 0.18, nightGlow: 1.0 },
	mumbai: { dust: 0.28, nightGlow: 1.0 },
	dubai: { dust: 0.22, nightGlow: 1.25 },
	dallas: { dust: 0.15, nightGlow: 1.0 },
	phoenix: { dust: 0.3, nightGlow: 0.9 },
	las_vegas: { dust: 0.2, nightGlow: 1.25 },
	denver: { dust: 0.05, nightGlow: 1.0 },
	chicago_midway: { dust: 0.08, nightGlow: 1.0 },
	himalayas: { dust: 0.0, nightGlow: 0.7 },
	ocean: { dust: 0.12, nightGlow: 0.5 },
	desert: { dust: 0.38, nightGlow: 0.55 }
};

export const LOCATIONS = Location.all();

/**
 * The places the wall actually flies between.
 *
 * Six, not eleven. The fielded aero-1 rotation hopped between a curated set
 * and the room read as a journey; eleven places on a four-minute dwell read
 * as a slideshow. Home first, then the Southwest hubs, with Dubai for a
 * daylight hour while India is at its desk (every US hub is night during
 * IST office hours). Every entry has a Sentinel-2 pack, a roads pack, a
 * towns pack and a buildings pack on disk; add a place here only after
 * packing it, or the offline Pi shows a void for ten minutes.
 *
 * The catalogue stays whole for the operator picker and `?place=`.
 */
export const ROTATION: readonly Location[] = [
	'hyderabad',
	'dubai',
	'dallas',
	'denver',
	'las_vegas',
	'chicago_midway'
].map((id) => Location.byId(id));
