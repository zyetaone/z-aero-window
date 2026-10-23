import { expect, test } from 'bun:test';
import { NO_WALL } from '#ops/wall.ts';
import { readParams } from './params.ts';
import { planFlight, planPlace } from './plan.ts';

const at = Date.UTC(2026, 9, 6, 12, 3);

test('three panes in one slot get one visit, turned to their own window', () => {
	const [l, c, r] = ['left', 'center', 'right'].map((role) => planFlight(readParams(`?role=${role}`), NO_WALL, at));
	const { paneYaw: _l, track: _tl, ...left } = l!;
	const { paneYaw: _c, track: _tc, ...centre } = c!;
	expect(left).toEqual(centre);
	expect(l!.track.cruiseM).toBe(c!.track.cruiseM);
	expect([l!.paneYaw, c!.paneYaw, r!.paneYaw].map(Math.sign)).toEqual([-1, 0, 1]);
});

test('the URL beats the wall, and the wall beats the rotation', () => {
	const wall = { ...NO_WALL, place: 'himalayas', clock: 6.5 };
	expect(planFlight(readParams(''), wall, at)).toMatchObject({ placeId: 'himalayas', clock: 6.5 });
	expect(planFlight(readParams('?place=dubai&clock=21&seat=ahead'), wall, at)).toMatchObject({ placeId: 'dubai', clock: 21, seat: 'ahead' });
	expect(planFlight(readParams('?place=atlantis&seat=roof'), NO_WALL, at).pinnedPlace).toBeNull();
});

test('planPlace picks the same place planFlight flies, so the live fetch hits the right city', () => {
	expect(planPlace(readParams('?place=dubai'), NO_WALL, at).placeId).toBe('dubai');
	expect(planPlace(readParams(''), { ...NO_WALL, place: 'himalayas' }, at).placeId).toBe('himalayas');
	const both = planFlight(readParams('?place=dubai'), NO_WALL, at);
	expect(planPlace(readParams('?place=dubai'), NO_WALL, at)).toMatchObject({ placeId: both.placeId, lat: both.lat, lon: both.lon });
});

test('a live reading sits between the operator pin and the daily static', () => {
	// Nothing pinned, live storm → the visit flies the storm.
	expect(planFlight(readParams(''), NO_WALL, at, 'storm')).toMatchObject({ weather: { name: 'storm' } });
	// The wall's pin beats live.
	expect(planFlight(readParams(''), { ...NO_WALL, weather: 'storm' }, at, 'clear')).toMatchObject({ weather: { name: 'storm' } });
	// The URL beats live.
	expect(planFlight(readParams('?weather=clear'), NO_WALL, at, 'storm')).toMatchObject({ weather: { name: 'clear' } });
	// Live with no reading is the daily static; live equal to the daily is a no-op.
	const daily = planFlight(readParams(''), NO_WALL, at).weather.name;
	expect(planFlight(readParams(''), NO_WALL, at, daily)).toMatchObject({ weather: { name: daily } });
	const other = daily === 'storm' ? 'clear' : 'storm';
	expect(planFlight(readParams(''), NO_WALL, at, other)).toMatchObject({ weather: { name: other } });
});
