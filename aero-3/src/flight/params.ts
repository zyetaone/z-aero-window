/**
 * Every URL knob, read once. All optional, so a shot, the smoke test and the Pi bench
 * can pin a scene; a kiosk passes only `role` and `wall`. Numbers that are not finite
 * fall back to their default (`?scale=abc` must not NaN the engine).
 */
export type Role = 'left' | 'center' | 'right';

export function readParams(search: string) {
	const q = new URLSearchParams(search);
	const num = (name: string, fallback: number) => (q.has(name) && Number.isFinite(Number(q.get(name))) ? Number(q.get(name)) : fallback);
	const off = (name: string) => q.get(name) === '0';
	const role = (['left', 'center', 'right'] as const).find((r) => r === q.get('role')) ?? null;
	return {
		// Where and when
		/** Pin a city; absent, the wall-clock rotation picks it (or the wall). */
		place: q.get('place'),
		/** Pin the local solar hour, 0-24; NaN follows the wall or real time. */
		clock: num('clock', NaN),
		/** Pin today's regime: clear, fair, scattered, towering, cirrus, hazy, overcast. */
		weather: q.get('weather'),
		/** Pin the cruise, m over the ground; NaN flies the visit's own. */
		alt: num('alt', NaN),
		// The wall
		/** This pane in the wall, or null for a lone pane. */
		role,
		/** The pane's yaw off the centre, deg; absent, the role's (±24°). */
		yaw: q.has('yaw') ? num('yaw', 0) : null,
		/** Whose wall to follow: the centre Pi's origin. Empty: this pane's own server. */
		wall: q.get('wall') ?? '',
		/** The blind and its reload each slot; off holds one visit (screenshots). */
		blind: !off('blind'),
		frame: !off('frame'),
		/** The cabin drone: only a centre or lone pane plays it anyway. */
		audio: !off('audio'),
		/** The clock panel: default off on a wall pane, on alone. */
		hud: (q.get('hud') ?? (role ? '0' : '1')) !== '0',
		// The look (lighting.ts Knobs)
		sky: num('sky', 1.7),
		lift: num('lift', 8),
		lamps: num('lamps', 1),
		carpet: num('carpet', 1),
		moonlight: num('moonlight', 0.4),
		/** Final contrast; NaN takes today's (weather.ts). */
		contrast: num('contrast', NaN),
		/** Cloud cover scale, 0 clear. */
		clouds: num('clouds', 1),
		// Layers, for bench ablations
		moon: !off('moon'),
		glow: !off('glow'),
		trees: !off('trees'),
		wing: !off('wing'),
		/** Pin the row: behind, over or ahead of the wing; absent, the visit's own. */
		seat: q.get('seat'),
		// The engine
		scale: Math.max(0.25, num('scale', 1)),
		webgpu: q.get('gpu') === 'webgpu',
		/** MSAA; off only to bench it. */
		aa: !off('aa'),
		/** Expose scene, camera, terrain, atmosphere and aim on globalThis. */
		debug: q.has('debug')
	};
}

export type Params = ReturnType<typeof readParams>;
