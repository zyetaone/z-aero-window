import { describe, it, expect, vi } from 'vitest';

/**
 * Both OS-facing dependencies are mocked for the ROUTE suite below, which tests
 * the auth gate rather than the machine.
 *
 * Unmocked, each one asserts a property of the host instead of the code. On
 * darwin `wifiRecoveryAvailable` is vacuously true and `schedulePrivileged`
 * no-ops to true, so the gate opens and the test passes. On Linux the portal
 * files do not exist in a container and `sudo -n` fails, so the route correctly
 * refuses with 503 — and the test failed on CI while the route, the guard and
 * the helper were all behaving exactly as designed.
 *
 * The real branching logic keeps its coverage: `wifiRecoveryAvailable` is
 * exercised directly with injected platform/exists in the first describe below
 * (which is why it is imported through `importActual`), and the privileged
 * helper is covered in privileged.test.ts.
 */
vi.mock('#lib/server/privileged.js', () => ({ schedulePrivileged: () => true }));
vi.mock('#lib/server/wifi.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/server/wifi.js')>()),
	wifiRecoveryAvailable: vi.fn(() => ({ ok: true }))
}));

const { PORTAL_BIN, PORTAL_UNIT, wifiRecoveryAvailable } =
	await vi.importActual<typeof import('#lib/server/wifi.js')>('#lib/server/wifi.js');

import { POST } from '../src/routes/api/wifi/reset/+server.js';

describe('wifiRecoveryAvailable', () => {
	const has =
		(...present: string[]) =>
		(p: string) =>
			present.includes(p);

	it('is vacuously available off Linux, where no purge can happen', () => {
		expect(wifiRecoveryAvailable('darwin', () => false).ok).toBe(true);
	});

	/**
	 * This is the check that stops the endpoint being a remote brick button.
	 * Both halves matter: the unit without the binary reboots into a portal that
	 * cannot exec, which is the same offline device.
	 */
	it('refuses on Linux when either half of the portal is absent', () => {
		expect(wifiRecoveryAvailable('linux', has()).ok).toBe(false);
		expect(wifiRecoveryAvailable('linux', has(PORTAL_UNIT))).toMatchObject({
			ok: false,
			reason: expect.stringContaining(PORTAL_BIN)
		});
		expect(wifiRecoveryAvailable('linux', has(PORTAL_BIN))).toMatchObject({
			ok: false,
			reason: expect.stringContaining(PORTAL_UNIT)
		});
	});

	it('allows the purge only when both are present', () => {
		expect(wifiRecoveryAvailable('linux', has(PORTAL_UNIT, PORTAL_BIN)).ok).toBe(true);
	});
});

describe('POST /api/wifi/reset', () => {
	const call = (auth?: string) =>
		POST({
			request: new Request('http://pane/api/wifi/reset', {
				method: 'POST',
				...(auth ? { headers: { authorization: auth } } : {})
			})
		} as Parameters<typeof POST>[0]);

	/**
	 * Fail-closed is the whole posture at this edge: a Pi deployed without the
	 * token has no remote reboot lever, rather than an open one.
	 */
	it('refuses with 503 when the token is unset', async () => {
		delete process.env.AERO_WIFI_RESET_TOKEN;
		expect((await call('Bearer anything')).status).toBe(503);
	});

	it('refuses with 401 for a wrong token', async () => {
		process.env.AERO_WIFI_RESET_TOKEN = 'field-tech';
		try {
			expect((await call('Bearer wrong')).status).toBe(401);
			expect((await call()).status).toBe(401);
		} finally {
			delete process.env.AERO_WIFI_RESET_TOKEN;
		}
	});

	/**
	 * With the right token this reaches the purge path — which is a no-op off
	 * Linux by schedulePrivileged's contract, so the assertion is that the gate
	 * opened, not that a Pi rebooted.
	 */
	it('proceeds past the gate with the right token', async () => {
		process.env.AERO_WIFI_RESET_TOKEN = 'field-tech';
		try {
			const res = await call('Bearer field-tech');
			expect(res.status).not.toBe(401);
			expect(res.status).not.toBe(503);
		} finally {
			delete process.env.AERO_WIFI_RESET_TOKEN;
		}
	});
});
