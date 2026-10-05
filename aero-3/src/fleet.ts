/**
 * Fleet health: the heartbeat each Pi's deploy/pi/health-check.sh POSTs to the wall
 * Pi every few minutes (its own fps, temperature, uptime, restarts, commit, last
 * journal error, thermal action, clock), checked here once for the server and read
 * by /admin's table. Pure, so it is tested without a server.
 */
export type Heartbeat = {
	deviceId: string;
	role: string;
	fps: number;
	temp: number;
	uptime: number;
	crashCount: number;
	commit: string;
	lastError: string;
	thermalAction: string;
	clockMs?: number;
};
/** A heartbeat as the wall Pi stored it: `receivedAt` is its own clock, so `clockMs` minus it is that pane's skew. */
export type FleetRow = Heartbeat & { receivedAt: number };

export const MAX_HEARTBEAT_BYTES = 2048;
export const MAX_DEVICES = 32; // a wall is three; a typo'd deviceId loop must not grow the map forever
export const STALE_SEC = 600; // health-check.sh runs every few minutes: two missed beats is a dead pane

/** The heartbeat in `body`, every field typed and capped, or null when it is not one. */
export function parseHeartbeat(body: unknown): Heartbeat | null {
	if (!body || typeof body !== 'object') return null;
	const b = body as Record<string, unknown>;
	const str = (k: string, max: number) => (typeof b[k] === 'string' ? (b[k] as string).slice(0, max) : '');
	const num = (k: string) => (typeof b[k] === 'number' && Number.isFinite(b[k]) ? (b[k] as number) : 0);
	const deviceId = str('deviceId', 64);
	if (!/^[\w.-]+$/.test(deviceId)) return null;
	const clock = typeof b.clockMs === 'number' && Number.isFinite(b.clockMs) ? { clockMs: b.clockMs } : {};
	return { deviceId, role: str('role', 16), fps: num('fps'), temp: num('temp'), uptime: num('uptime'), crashCount: num('crashCount'), commit: str('commit', 40), lastError: str('lastError', 200), thermalAction: str('thermalAction', 16), ...clock };
}
