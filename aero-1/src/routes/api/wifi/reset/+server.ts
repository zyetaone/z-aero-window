/**
 * POST /api/wifi/reset — purge saved WiFi profiles + reboot.
 *
 * On next boot the Pi has no WiFi → aero-wifi-portal.service detects this
 * and spawns the captive setup AP. The customer reconfigures from their phone.
 *
 * Auth model: bearer token via `Authorization: Bearer <AERO_WIFI_RESET_TOKEN>`.
 * The token is read from `process.env.AERO_WIFI_RESET_TOKEN`. If the env var
 * is unset, the endpoint fails closed with 503 — no accidental reboots if
 * the Pi is deployed without explicitly enabling this hatch. This matches
 * the codebase's "fail closed at the dangerous edge, LAN-trust everywhere
 * else" posture.
 */

import { json } from '@sveltejs/kit';
import { corsPreflight } from '$lib/http/cors';
import { requireBearerToken } from '$lib/http/auth';
import { schedulePrivileged } from '$lib/server/schedule-privileged';
import { wifiRecoveryAvailable } from '$lib/server/wifi-recovery';
import type { RequestHandler } from './$types';


export const OPTIONS: RequestHandler = corsPreflight('POST, OPTIONS');

export const POST: RequestHandler = async ({ request }) => {
	requireBearerToken(request, 'AERO_WIFI_RESET_TOKEN', 'wifi reset endpoint');

	// Refuse to purge a working connection when nothing can restore one.
	const recovery = wifiRecoveryAvailable();
	if (!recovery.ok) {
		return json(
			{
				ok: false,
				message:
					`Refusing to clear WiFi: the setup portal is not installed (${recovery.reason}), ` +
					'so this device would reboot with no network and no way to reconfigure it — ' +
					'recoverable only by physically attaching a keyboard or reflashing the SD card. ' +
					'Install the portal (deploy/aero-wifi-portal.service + /usr/local/bin/wifi-connect) first.',
			},
			{ status: 503 },
		);
	}
	// Async fire-and-forget: schedule the reset for ~2s out so we have time to
	// return a 200 to the caller before the network drops + reboot kicks in.
	// schedulePrivileged preflights `sudo -n` on Linux — if the box can't run
	// the purge at all, say so with a 503 instead of lying with a 200.
	if (!scheduleReset()) {
		return json(
			{ ok: false, message: 'Privileged hatch unavailable (sudo -n preflight failed) — reinstall deploy/pi/install.sh to provision /etc/sudoers.d/aero.' },
			{ status: 503 },
		);
	}
	return json({
		ok: true,
		message: 'WiFi will be cleared and the device will reboot in ~2 seconds. Reconnect via the setup portal.',
	});
};

/** Internal — only invokable on the Pi (uses sudo + nmcli + reboot). Returns false if not scheduled. */
function scheduleReset(): boolean {
	// Delete every saved 802-11-wireless connection, then reboot.
	// `sudo -n` (non-interactive), matching /api/update: schedulePrivileged
	// spawns with stdio 'ignore' and no TTY, so an interactive password prompt
	// would hang the purge forever with the operator seeing nothing. -n fails
	// fast and loudly instead. The 2 s delay lets the 200 reach the caller
	// before the network drops + reboot kicks in.
	// Iterate connection UUIDs, not names: NAME values can contain spaces
	// ("My Home WiFi") and the old `for c in $(...)` loop word-split them, so
	// the delete silently failed and the Pi rebooted back onto the surviving
	// profile — portal never came up. UUIDs are space-free, so `while read`
	// is safe. No `|| true`: if any delete fails, `exit 1` (while-loop runs in
	// the pipeline's subshell) fails the pipeline and `&&` skips the reboot —
	// better to stay up on a stale profile than to reboot into one.
	// The leading `nmcli ... >/dev/null || exit 1` preflights the enumerate
	// step itself: `sh` has no pipefail, so without it a failed `nmcli`
	// (NetworkManager down) feeds the loop nothing, the pipeline exits 0,
	// and the Pi reboots without purging.
	return schedulePrivileged(
		['sh', '-c', `nmcli -t -f UUID,TYPE c >/dev/null || exit 1; nmcli -t -f UUID,TYPE c | awk -F: '$2=="802-11-wireless"{print $1}' | while read -r u; do sudo -n nmcli connection delete "$u" || exit 1; done && sudo -n /sbin/reboot`],
		2000,
		'[wifi/reset]',
	);
}
