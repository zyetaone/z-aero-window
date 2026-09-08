#!/usr/bin/env node
/**
 * smoke-routes — load every page route in a real headless browser and assert
 * it actually RENDERED.
 *
 * This is the only check in the repo that can see a whole class of failure.
 * `svelte-check` is green on a component that throws during init; the unit
 * suite is green because it never mounts the route; and the kiosk keeps
 * working because the break is on a page nobody loaded. What that produces is
 * an empty <body> served with a 200 — the parent repo shipped exactly this on
 * /admin, with 489 green tests. `curl` cannot see it either: `ssr = false`
 * means the static shell returns 200 whether or not the app boots inside it.
 *
 * It also asserts the thing that outranks a rendered page here: that the
 * kiosk is FLYING. A frozen window is a photograph of an aeroplane window and
 * is indistinguishable from the product in a screenshot, so the check is that
 * the pose CHANGED between two samples, not that a canvas exists.
 *
 * Self-contained on purpose — it builds nothing, but it starts the server and
 * the browser and tears both down, because a smoke test with a three-command
 * setup is a smoke test that stops being run. It needs a build:
 *
 *   bun run build && bun run smoke
 *
 * No dependencies: Node 22+ has a global WebSocket, and the CDP calls used
 * here are a dozen lines. Adding `chrome-remote-interface` to ship a kiosk
 * would be a production dependency for a dev script.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name, dflt) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? dflt : process.argv[i + 1];
};
const PORT = Number(arg('port', 5399));
const CDP_PORT = Number(arg('cdp-port', 9455));
const BASE = arg('base', `http://127.0.0.1:${PORT}`);
const KEEP = process.argv.includes('--keep');

const CHROME_CANDIDATES = [
	process.env.CHROME,
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/Applications/Chromium.app/Contents/MacOS/Chromium',
	'/usr/bin/chromium-browser',
	'/usr/bin/chromium',
	'/usr/bin/google-chrome'
].filter(Boolean);

/**
 * `expect` is a string the page cannot render without having actually run.
 *
 * Deliberately not a selector: a mounted-but-empty component satisfies a
 * selector, and that is the failure being hunted.
 */
const ROUTES = [
	{ path: '/', minChars: 40, canvas: true, flying: true, drawers: true },
	// The kiosk with the blind DOWN. Same route, and the one state where a
	// blank screen is correct — so `minChars` alone cannot judge it, and a
	// regression here looks exactly like success.
	{ path: '/?blind=closed', minChars: 0, canvas: true, flying: true },
	{ path: '/admin', expect: 'Fleet', minChars: 200 },
	{ path: '/wiki', minChars: 200 },
	/**
	 * The non-flight display modes, which are the easiest thing in this repo
	 * to ship broken: all three were, until 2026-09-03, because the CSP had no
	 * `media-src` and the defaults pointed at third-party CDNs. Nothing failed
	 * loudly — `<video>` fired `onerror`, MediaStage caught it, and the pane
	 * rendered a tidy "Media failed to load" that reads as handled absence
	 * rather than a header bug.
	 *
	 * What this route DOES cover: `?mode=` and `?media=` are parsed,
	 * MediaStage mounts, and the element decodes. Emptying the playlist
	 * parser turns it red — verified.
	 *
	 * What it does NOT cover, and this was measured rather than assumed: the
	 * CSP itself. The asset is same-origin, so `default-src 'self'` admits it
	 * whether or not `media-src` and the `blob:`/origin entries exist —
	 * deleting them leaves this route green. Covering the directive needs a
	 * SECOND HTTP origin, which is more machinery than a route smoke test
	 * should carry. That half was verified by hand, both ways: a cross-origin
	 * image is blocked with `AERO_MEDIA_ORIGINS` unset and loads with it set.
	 *
	 * Only the slideshow, because video needs a real playable file and adding
	 * an mp4 fixture to `static/` would ship it in every production build. The
	 * two modes share one MediaStage, one parser and one directive.
	 */
	{ path: '/?mode=screensaver&media=/cloud.webp', minChars: 0, mediaLoaded: true }
];

// ── tiny CDP client ──────────────────────────────────────────────────────────

async function connect(wsUrl) {
	const ws = new WebSocket(wsUrl);
	const pending = new Map();
	const listeners = [];
	await new Promise((res, rej) => {
		ws.onopen = res;
		ws.onerror = () => rej(new Error(`cannot reach devtools at ${wsUrl}`));
	});
	ws.onmessage = (e) => {
		const msg = JSON.parse(e.data);
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
		} else if (msg.method) {
			for (const fn of listeners) fn(msg);
		}
	};
	let id = 0;
	return {
		send: (method, params = {}, sessionId) =>
			new Promise((resolve, reject) => {
				const n = ++id;
				pending.set(n, { resolve, reject });
				ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
			}),
		on: (fn) => listeners.push(fn),
		off: (fn) => listeners.splice(listeners.indexOf(fn), 1),
		close: () => ws.close()
	};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(label, fn, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const v = await fn();
			if (v) return v;
		} catch {
			/* not up yet */
		}
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await sleep(250);
	}
}

// ── run ──────────────────────────────────────────────────────────────────────

if (!existsSync('build/index.js')) {
	console.error('no build/index.js — run `bun run build` first.');
	process.exit(1);
}

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chromePath) {
	console.error(
		`no Chrome found. Set CHROME=/path/to/chrome. Tried:\n  ${CHROME_CANDIDATES.join('\n  ')}`
	);
	process.exit(1);
}

/**
 * `NODE_ENV` is DELETED, not set to production, and the distinction is the
 * whole reason this file can check both things it needs to.
 *
 * Unset is the Pi's own configuration: `remoteFallbackEnabled` only returns
 * true for the literal string `development`, so the run sees the real offline
 * archive rather than quietly proxying NASA — which would make a smoke test
 * pass on any machine with internet and say nothing about a fielded device.
 *
 * /admin is opened here with AERO_ADMIN_UI=1, which matters because /admin is
 * the exact page the parent repo shipped blank. Without the flag the route
 * 404s by design, so smoking it that way asserts the guard and abandons the
 * cockpit to the failure this tool exists to catch. The guard is checked
 * separately below, against a second server that omits the flag.
 */
// AERO_ADMIN_UI=1 so /admin RENDERS here and the blank-cockpit check has
// something to look at. The inverse — that it 404s WITHOUT the flag — is a
// separate server at the bottom of this file.
const kioskEnv = { ...process.env, PORT: String(PORT), AERO_ADMIN_UI: '1' };
// `NODE_ENV: undefined` inside the spread would still hand the child the key;
// only deleting it reproduces an unprovisioned Pi.
delete kioskEnv.NODE_ENV;
const server = spawn(process.execPath, ['build/index.js'], {
	env: kioskEnv,
	stdio: ['ignore', 'pipe', 'pipe']
});
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));

const profile = mkdtempSync(join(tmpdir(), 'aero-smoke-'));
const chrome = spawn(
	chromePath,
	[
		'--headless=new',
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-extensions',
		// The kiosk is a WebGL app; software rendering would be a different test.
		'--enable-webgl',
		/**
		 * ANGLE locally, SwiftShader on a headless CI runner.
		 *
		 * MapLibre v6 hard-requires WebGL2 and throws GPUInitializationError
		 * without it — no map, no canvas, and every kiosk assertion below fails.
		 * `--use-gl=angle` needs a GPU to bind to, which a GitHub runner does not
		 * have, so on CI it produces exactly the blank page this tool exists to
		 * detect and the failure looks like a real regression.
		 *
		 * SwiftShader is a genuine WebGL2 implementation in software, so the app
		 * really does initialise, really does mount a map, and really does fly.
		 * What it cannot vouch for is GPU-specific behaviour or frame rate —
		 * neither of which this check ever claimed to measure.
		 *
		 * `--no-sandbox` for the same reason: unprivileged user namespaces are
		 * unavailable in most containers, and Chrome refuses to start without it.
		 */
		...(process.env.CI
			? [
					'--use-gl=swiftshader',
					'--enable-unsafe-swiftshader',
					'--no-sandbox',
					'--disable-dev-shm-usage'
				]
			: ['--use-gl=angle']),
		`--remote-debugging-port=${CDP_PORT}`,
		`--user-data-dir=${profile}`,
		'about:blank'
	],
	{ stdio: 'ignore' }
);

let failed = 0;
let cdp;

const shutdown = () => {
	try {
		cdp?.close();
	} catch {
		/* already gone */
	}
	if (!KEEP) {
		chrome.kill();
		server.kill();
	}
};
process.on('exit', shutdown);
process.on('SIGINT', () => process.exit(130));

try {
	await waitFor('server', async () => (await fetch(BASE + '/api/tiles/health')).ok);
	const version = await waitFor('devtools', async () =>
		(await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()
	);

	/**
	 * The archive state is reported, not asserted.
	 *
	 * A dev workstation legitimately has no local pack, and failing the smoke
	 * run there would train people to ignore it. But a run against an `error`
	 * archive is a run where the ground is a white sheet, so saying so next to
	 * the route results is what stops a green tick being misread.
	 */
	const health = await (await fetch(BASE + '/api/tiles/health')).json();
	if (health.status !== 'ok') {
		console.log(`note  tile archive ${health.status}: missing ${health.missing.join(', ') || '—'}`);
	}

	cdp = await connect(version.webSocketDebuggerUrl);

	/**
	 * A fresh tab, driven over a flat session.
	 *
	 * Attaching to whatever tab Chrome happened to open would inherit
	 * `about:blank`'s state and, worse, any listener the browser target emits.
	 * `flatten: true` multiplexes the page session over the browser socket, so
	 * every non-Target command below just carries its sessionId.
	 */
	const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
	const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
	const send = (method, params = {}) => cdp.send(method, params, sessionId);

	await send('Page.enable');
	await send('Runtime.enable');

	const evaluate = async (expression) =>
		(await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result
			.value;

	/**
	 * Warm the shader cache before anything is GRADED.
	 *
	 * Under SwiftShader the first MapLibre load compiles every shader in
	 * software, and on a GitHub runner that first compile can fail outright
	 * ("Could not compile fragment shader") where the second succeeds — the
	 * observed signature was `/` failing while `/?blind=closed`, the same map
	 * seconds later, mounted four canvases. Whichever route happened to be
	 * first paid a cost that had nothing to do with that route.
	 *
	 * So pay it once, deliberately, outside the loop, and let the graded routes
	 * all start from the same warm state. This does NOT weaken the check: every
	 * route below still has to render, mount its canvas and prove it is flying.
	 * It only stops the FIRST of them from also having to prove that a cold
	 * software GL stack can bootstrap.
	 */
	if (process.env.CI) {
		await send('Page.navigate', { url: BASE + '/' });
		await waitFor(
			'shader warm-up',
			async () => ((await evaluate("document.querySelectorAll('canvas').length")) ?? 0) > 0,
			60_000
		).catch(() => console.log('note  warm-up did not reach a canvas; grading anyway'));
		await sleep(3_000);
	}

	for (const route of ROUTES) {
		const errors = [];
		const onEvent = (msg) => {
			if (msg.method === 'Runtime.exceptionThrown') {
				errors.push(msg.params.exceptionDetails?.exception?.description ?? 'exception');
			}
			if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
				/**
				 * Take the WHOLE argument list, and never substitute a placeholder.
				 *
				 * This read `args[0].value ?? 'console.error'`, and MapLibre logs
				 * its tile failures as a structured Error object whose first arg
				 * has a `description` but no `value` — so every one of them became
				 * the literal string "console.error", which contains "Error" and
				 * matched the fatal filter below. On a machine with no tile pack
				 * that turned a legitimately degraded archive into three failed
				 * routes: the smoke test reported the kiosk broken when it was
				 * merely showing a blank basemap.
				 */
				const text = (msg.params.args ?? [])
					.map((a) => a.value ?? a.description ?? a.unserializableValue ?? '')
					.join(' ')
					.trim();
				errors.push(text || '(empty console.error)');
			}
		};
		cdp.on(onEvent);

		await send('Page.navigate', { url: BASE + route.path });
		/**
		 * POLL for readiness rather than sleeping a fixed 12s.
		 *
		 * A flat sleep encodes one machine's speed. It was tuned on a GPU, and
		 * under SwiftShader on a CI runner the FIRST canvas route needs longer:
		 * the software driver compiles MapLibre's shaders from cold, which the
		 * later routes then get for free from the program cache. CI failed on `/`
		 * with "Could not compile fragment shader" while `/?blind=closed` — the
		 * same map, moments later — passed, and a 5-of-6 result whose only
		 * failure is the first route is the signature of a warm-up cost, not a
		 * broken page.
		 *
		 * Waiting on the condition is both faster on a fast machine and correct
		 * on a slow one. The ceiling stays generous because being wrong here
		 * costs a false red on the one check that guards blank pages.
		 */
		if (route.canvas) {
			await waitFor(
				`${route.path} canvas`,
				async () => ((await evaluate("document.querySelectorAll('canvas').length")) ?? 0) > 0,
				45_000
			).catch(() => {
				/* Fall through: the assertions below report what is actually wrong. */
			});
			// The canvas exists; give the first frames a moment to land.
			await sleep(2_000);
		} else {
			await sleep(4_000);
		}

		/**
		 * A media route needs its IMAGE decoded, which a canvas wait does not
		 * imply and a flat sleep does not guarantee.
		 *
		 * This was a fixed 4 s and it was enough on a developer machine and not
		 * on a CI runner: under SwiftShader the screensaver route reported "no
		 * media element mounted" while every other route passed, purely because
		 * decoding lost a race the assertion then read as a broken MediaStage.
		 * Same lesson as the canvas wait above — poll the condition, do not
		 * encode one machine's speed as a number.
		 */
		if (route.mediaLoaded) {
			await waitFor(
				`${route.path} media`,
				async () =>
					(await evaluate(
						"(() => { const e = document.querySelector('.media-stage img');" +
							'return !!(e && e.naturalWidth > 0); })()'
					)) === true,
				30_000
			).catch(() => {
				/* Fall through: the assertion below says what is actually missing. */
			});
		}

		const text = (await evaluate('document.body.innerText')) ?? '';
		const canvases = await evaluate("document.querySelectorAll('canvas').length");
		const problems = [];

		if (text.trim().length < route.minChars) {
			problems.push(`rendered ${text.trim().length} chars, expected >= ${route.minChars} (blank?)`);
		}
		if (route.expect && !text.includes(route.expect)) {
			problems.push(`missing expected text ${JSON.stringify(route.expect)}`);
		}
		/**
		 * Did the media element actually take the source, and decode it?
		 *
		 * A DECODED pixel, not rendered text. The first draft asserted the
		 * ABSENCE of "Media failed to load", which was worth nothing: MediaStage
		 * has a second empty state reading "No media specified", so emptying the
		 * playlist entirely still passed. Verified by emptying it.
		 */
		if (route.mediaLoaded) {
			const found = await evaluate(
				"(() => { const e = document.querySelector('.media-stage img');" +
					'return e ? JSON.stringify({ src: e.getAttribute("src"), decoded: e.naturalWidth > 0 }) : null; })()'
			);
			if (!found) {
				problems.push('no media element mounted — MediaStage fell through to an empty state');
			} else {
				const el = JSON.parse(found);
				if (!el.decoded) problems.push(`media mounted but never decoded (src=${el.src})`);
			}
		}
		if (route.canvas && canvases < 1) problems.push('no canvas mounted');

		/**
		 * Is it actually flying?
		 *
		 * A stalled render loop leaves a live canvas holding its last frame at a
		 * plausible altitude with a clean console — every other assertion here
		 * passes on a frozen window. Two samples a second apart, compared on the
		 * camera's own centre, is the smallest thing that can tell the
		 * difference. `__stage` is the map handle Stage.svelte publishes.
		 */
		if (route.flying) {
			const pose = () =>
				evaluate(
					'(() => { const m = window.__stage; if (!m) return null;' +
						'const c = m.getCenter(); return `${c.lng},${c.lat},${m.getPitch()},${m.getBearing()}`; })()'
				);
			const before = await pose();
			if (before === null) {
				problems.push('no map on window.__stage — the world never mounted');
			} else {
				await sleep(1200);
				if ((await pose()) === before) problems.push(`pose frozen at ${before}`);
			}
		}

		/**
		 * Press the operator's keys and check the panel actually rendered.
		 *
		 * Everything above loads a URL, and the operator UI is not reachable by
		 * URL — `showSettings` is component state behind an `s` keypress. So the
		 * entire settings drawer and admin panel were outside every gate in the
		 * repo: `svelte-check` cannot see a runtime throw, no unit test mounts
		 * them, and the kiosk route renders perfectly with a drawer that dies
		 * the instant it opens.
		 *
		 * It did. `Segmented` keyed its `{#each}` on `String(option)`, which is
		 * `"[object Object]"` for all eleven Locations, so opening the panel
		 * threw `each_key_duplicate` and rendered "Internal Error". Found by
		 * hand, not by any check — this is that check.
		 *
		 * Asserts a control that only exists BELOW the failure: a labelled
		 * range input inside the drawer. Presence of the drawer element alone
		 * would pass on the error card, which replaces the contents rather than
		 * the container.
		 */
		if (route.drawers) {
			/**
			 * Each drawer is asserted on what IT contains, not on a shared
			 * shape. The settings panel is controls; the admin panel is a
			 * read-only telemetry readout with no inputs at all, so demanding a
			 * slider there fails an entirely healthy page. A smoke check that
			 * has to be loosened to pass stops meaning anything.
			 */
			for (const [k, label, probe] of [
				['s', 'settings', "document.querySelectorAll('input[type=range], button.opt').length"],
				['a', 'admin', "document.querySelectorAll('.diag-item').length"]
			]) {
				await evaluate(
					`window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true}))`
				);
				await sleep(700);
				const state = await evaluate(
					'(() => {' +
						"const err = document.body.innerText.includes('Internal Error');" +
						`const inputs = ${probe};` +
						'return JSON.stringify({ err, inputs }); })()'
				);
				const { err, inputs } = JSON.parse(state);
				if (err) problems.push(`${label} drawer threw during render (Internal Error)`);
				else if (inputs === 0) problems.push(`${label} drawer opened but rendered no controls`);
				// Close it again so the next key lands on a clean panel.
				await evaluate(
					`window.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k)},bubbles:true}))`
				);
				await sleep(300);
			}
		}

		// An init throw is the /admin failure mode. Tile 404s over a sparse
		// archive are expected and are reported by the health note above.
		// Tile misses are not a broken page — an incomplete archive is a
		// legitimate state that `note tile archive ...` above already reports.
		// What matters is a throw during init, which is the /admin failure mode.
		const fatal = errors.filter(
			(e) =>
				!/Failed to load resource|404|AJAXError|Unable to parse|tile/i.test(e) &&
				/Error|not a function|undefined/i.test(e)
		);
		if (fatal.length) problems.push(`init error: ${fatal[0].slice(0, 140)}`);

		if (problems.length) {
			failed++;
			console.log(`FAIL  ${route.path}`);
			for (const p of problems) console.log(`        ${p}`);
		} else {
			console.log(`ok    ${route.path}  (${text.trim().length} chars, ${canvases} canvas)`);
		}
		cdp.off(onEvent);
	}

	/**
	 * /admin must 404 for a server given NO admin flag, and GET /admin does NOT
	 * test that: with `ssr = false` the static shell returns 200 whether the
	 * guard fires or not. The guard runs in the load function, so the DATA
	 * request is the only place its absence is visible.
	 *
	 * The env here is the DEFAULT one — nothing added, `NODE_ENV` still
	 * deleted — because that is the state a fielded Pi boots in and therefore
	 * the state the guard has to hold in. It previously set
	 * `NODE_ENV=production` to make a `!== 'production'` guard fire, which
	 * asserted the one configuration that was already safe and said nothing
	 * about the default. Under that default /admin served its full cockpit
	 * data node, and this check passed.
	 *
	 * Its own server, because the run above sets AERO_ADMIN_UI=1 so the
	 * cockpit RENDERS and can be checked for the blank-page failure. One
	 * process cannot answer both questions, and dropping either loses a real
	 * failure: the cockpit shipping blank, or the cockpit shipping to a client
	 * LAN.
	 */
	const guardEnv = { ...process.env, PORT: String(PORT + 1) };
	delete guardEnv.NODE_ENV;
	delete guardEnv.AERO_ADMIN_UI;
	const guardServer = spawn(process.execPath, ['build/index.js'], {
		env: guardEnv,
		stdio: 'ignore'
	});
	try {
		const guardBase = `http://127.0.0.1:${PORT + 1}`;
		await waitFor('unprovisioned server', async () => (await fetch(guardBase + '/api/status')).ok);
		const body = await (await fetch(guardBase + '/admin/__data.json')).text();
		if (!body.includes('"status":404')) {
			failed++;
			console.log('FAIL  /admin/__data.json');
			console.log(
				'        guard did not fire with AERO_ADMIN_UI unset — /admin is open on the LAN'
			);
		} else {
			console.log('ok    /admin/__data.json  (404 by default; AERO_ADMIN_UI unset)');
		}
	} finally {
		guardServer.kill();
	}

	/**
	 * An over-limit POST must answer 413 ON THE WIRE.
	 *
	 * `readLimitedJson` has unit tests asserting exactly this, and they passed
	 * while every real request got an empty `200`. A bare `new Request(...)` has
	 * no socket, so `reader.cancel()` had nothing to destroy; over HTTP it
	 * destroyed the connection adapter-node needed to write the 413 to. The
	 * suite was green and the wire was wrong, on `/api/wall` as shipped.
	 *
	 * Only a real request can see that, which is what this file is for.
	 */
	const oversized = JSON.stringify({ pad: 'x'.repeat(8000) });
	const res = await fetch(`${BASE}/api/wall`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: oversized
	});
	if (res.status !== 413) {
		failed++;
		console.log('FAIL  POST /api/wall (oversized body)');
		console.log(`        expected 413, got ${res.status} — the size guard cannot answer`);
	} else {
		console.log('ok    POST /api/wall  (oversized body -> 413)');
	}
} catch (err) {
	failed++;
	console.error(`FAIL  harness: ${err.message}`);
	if (serverLog.length) console.error(serverLog.join('').trim());
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall routes rendered and flying');
process.exit(failed ? 1 : 0);
