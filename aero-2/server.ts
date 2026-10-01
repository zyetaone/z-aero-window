/**
 * Server entrypoint for production and Pi fleet deployment.
 * Hands HTTP over to adapter-bun's built output (build/index.js), which
 * auto-starts a `Bun.serve` on import — the same contract adapter-node had.
 */
import { existsSync } from 'node:fs';

process.env.PORT ||= '5173';
const PORT = parseInt(process.env.PORT, 10);

// Production error logging for systemd journalctl
process.on('unhandledRejection', (reason) => {
	console.error('[server] FATAL unhandledRejection:', reason);
	process.exit(1);
});

process.on('uncaughtException', (err) => {
	console.error('[server] FATAL uncaughtException:', err);
	process.exit(1);
});

const BUILD_ENTRY = new URL('./build/index.js', import.meta.url);

/**
 * No build, no server.
 *
 * This used to fall back to a Bun.serve that answered every request with a 503
 * explaining that there was no build. On a Pi under systemd that is the worst
 * of both: the unit stays green, the port answers, the kiosk shows an error
 * page, and nothing restarts because nothing failed. Exiting non-zero makes
 * systemd say so — and it was the only Bun global in the file, which is why
 * tsconfig had to stop covering server.ts in order to stay green.
 */
if (!existsSync(BUILD_ENTRY)) {
	console.error('[server] FATAL no build/ found — run `bun run build` first, or `bun run dev`.');
	process.exit(1);
}

await import('./build/index.js');
console.log(`[server] Aero Window listening on http://localhost:${PORT}`);
