/**
 * parallax.ts — Multi-Pi Panoramic Window Wall Role and Camera Yaw Math.
 */

/**
 * The list is the source, the type is derived from it.
 *
 * Written as a bare union it was spelled out again in the settings state, again
 * in the URL parser, and again as an array in each picker -- four places, and a
 * fifth in the /admin cockpit that had drifted to the wrong yaw numbers. Adding
 * a role to a union does not add it to an `{#each}`; adding it here does both.
 * Same shape as `WEATHERS` in flight/view.ts, for the same reason.
 */
export const FLEET_ROLES = ['solo', 'center', 'left', 'right'] as const;
export type FleetRole = (typeof FLEET_ROLES)[number];

const PANORAMA_ARC_DEG = 72;

export function roleYawOffsetDeg(role: FleetRole): number {
	switch (role) {
		case 'left':
			return -(PANORAMA_ARC_DEG / 2 - PANORAMA_ARC_DEG / 6); // -24 deg
		case 'right':
			return +(PANORAMA_ARC_DEG / 2 - PANORAMA_ARC_DEG / 6); // +24 deg
		case 'center':
		case 'solo':
		default:
			return 0;
	}
}

export function isLeader(role: FleetRole): boolean {
	return role === 'solo' || role === 'center';
}

export function isEdge(role: FleetRole): boolean {
	return role === 'left' || role === 'right';
}
