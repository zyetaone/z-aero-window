/**
 * POST /api/wifi/reset — purge saved WiFi profiles and reboot.
 *
 * On the next boot the Pi has no WiFi, so the captive setup portal comes up and
 * the customer reconfigures it from their phone. This is the hatch that avoids
 * a site visit when a venue changes its SSID.
 *
 * Its own token, separate from the admin one: field techs hold this, the admin
 * token stays with whoever administers the wall. Same gate shape, different
 * blast radius. Fail-closed at 503 when unset — a Pi deployed without opting in
 * has no remote reboot lever at all rather than an open one.
 */

import { json } from '@sveltejs/kit';

import { requireBearer } from '#lib/server/auth.js';
import { corsPreflight, lanCorsHeaders, withCors } from '#lib/server/cors.js';
import { schedulePrivileged } from '#lib/server/privileged.js';
import { wifiRecoveryAvailable } from '#lib/server/wifi.js';
import type { RequestHandler } from './$types';

/**
 * Iterate connection UUIDs, never names: an SSID like "My Home WiFi" word-splits
 * in a `for c in $(...)` loop, so the delete silently failed and the Pi rebooted
 * back onto the surviving profile with the portal never coming up.
 *
 * No `|| true` anywhere. If any delete fails the pipeline fails and `&&` skips
 * the reboot — staying up on a stale profile beats rebooting into none. The
 * leading enumerate-or-exit preflights that step too: `sh` has no pipefail, so
 * without it a dead NetworkManager feeds the loop nothing, the pipeline exits 0,
 * and the device reboots without having purged anything.
 */
const PURGE_AND_REBOOT =
	`nmcli -t -f UUID,TYPE c >/dev/null || exit 1; ` +
	`nmcli -t -f UUID,TYPE c | awk -F: '$2=="802-11-wireless"{print $1}' | ` +
	`while read -r u; do sudo -n nmcli c delete "$u" || exit 1; done && sudo -n /sbin/reboot`;

export const OPTIONS: RequestHandler = corsPreflight('POST, OPTIONS');

export const POST: RequestHandler = async ({ request }) => {
	const refusal = requireBearer(
		request,
		process.env.AERO_WIFI_RESET_TOKEN,
		'wifi reset endpoint (AERO_WIFI_RESET_TOKEN)'
	);
	const cors = lanCorsHeaders(request.headers.get('origin'));
	if (refusal) return withCors(refusal, cors);

	const recovery = wifiRecoveryAvailable();
	if (!recovery.ok) {
		return json(
			{
				ok: false,
				message:
					`Refusing to clear WiFi: the setup portal is not installed (${recovery.reason}), so this ` +
					'device would reboot with no network and no way to reconfigure it — recoverable only by ' +
					'physically attaching a keyboard or reflashing the SD card. Install the portal first.'
			},
			{ status: 503, headers: cors }
		);
	}

	// 2 s, not the updater's 0.5 s: the response has to clear the wire before the
	// network itself goes away, and this drops the link rather than the process.
	if (!schedulePrivileged(['sh', '-c', PURGE_AND_REBOOT], 2000, '[wifi/reset]')) {
		return json(
			{
				ok: false,
				message:
					'Privileged hatch unavailable: /etc/sudoers.d/aero is not installed — re-run deploy/pi/install.sh. (If it warned "sudoers fragment failed visudo validation", that is the cause.)'
			},
			{ status: 503, headers: cors }
		);
	}

	return json(
		{
			ok: true,
			message:
				'WiFi will be cleared and the device will reboot in about two seconds. Reconnect via the setup portal.'
		},
		{ headers: cors }
	);
};
