import { expect, test } from 'bun:test';
import { NO_WALL } from '#ops/wall.ts';
import { readParams } from './params.ts';
import { planFlight } from './plan.ts';

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
