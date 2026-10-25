/**
 * Server OTA updater.
 *
 * Fire-and-forget triggering of the Pi's systemd updater unit
 * (`aero-updater.service`).
 *
 * Reached through `routes/api/update/+server.ts`, which calls
 * `requireBearer(request, env.AERO_ADMIN_TOKEN, 'update (AERO_ADMIN_TOKEN)')`
 * and returns its Response when non-null before touching anything here. Keep
 * it that way: an unauthenticated endpoint that runs `sudo systemctl` is a
 * remote restart for anyone on the LAN.
 *
 * The argv is fixed at the call site rather than taken from a request, so there
 * is no injection surface — but reachability is the thing to get right, not
 * just escaping.
 */

import { spawnSync } from 'node:child_process';

import { schedulePrivileged } from '#lib/server/privileged.js';

/**
 * Triggers the on-demand fleet OTA updater on Raspberry Pi.
 * Runs `sudo -n systemctl start aero-updater.service`.
 */
export function triggerOtaUpdate(): boolean {
	return schedulePrivileged(
		['sudo', '-n', 'systemctl', 'start', 'aero-updater.service'],
		500,
		'[api/update]'
	);
}

/**
 * Returns the current application Git commit SHA if available.
 */
export function getAppCommit(): string {
	try {
		const res = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'ignore']
		});
		if (res.status === 0 && res.stdout) {
			return res.stdout.trim();
		}
	} catch {
		// Fallback for non-git runtime environments
	}
	return 'dev';
}
