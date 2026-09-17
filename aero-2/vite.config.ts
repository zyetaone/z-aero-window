import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Under `vitest`, resolve Svelte's BROWSER entry so components can be mounted.
 *
 * The defaults are spread back in, and that is the whole point. `conditions`
 * REPLACES Vite's list rather than extending it, so `['browser']` alone dropped
 * `module` and `development|production` — and on a clean Linux checkout the
 * rolldown dep optimizer then could not resolve `node:module` in its own
 * runtime, failing every CI run from 2026-08-28 with a startup error. It passed
 * on the author's machine, which is the failure mode this job exists to catch.
 */
const IS_TEST = process.env.VITEST !== undefined;

/**
 * Extra origins the non-flight display modes may pull media from.
 *
 * Empty by default, and that is the intended fielded configuration: a kiosk
 * showing a client's own video wall should be serving those files from the Pi,
 * not from someone's CDN. But the CSP has to be able to say yes, because
 * `video`/`screensaver`/`playlist` mode is otherwise a feature that cannot work
 * with any URL an operator can actually type.
 *
 * It was silently broken until 2026-09-03: there was no `media-src` at all, so
 * remote video and audio fell back to `default-src 'self'` and were blocked,
 * and `img-src` had no room for a slideshow. All three modes rendered "Media
 * failed to load" — the shipped DEFAULT playlists pointed at
 * commondatastorage.googleapis.com, actions.google.com and images.unsplash.com,
 * so the feature was 100% broken out of the box and nothing said so. There is
 * no unit test that can see this; it is a header versus a <video> tag.
 *
 * Space-separated origins, build-time (CSP is emitted into the HTML shell), so
 * changing it needs a rebuild rather than a restart:
 *   AERO_MEDIA_ORIGINS="https://cdn.example.com https://media.example.org"
 */
const MEDIA_ORIGINS = (process.env.AERO_MEDIA_ORIGINS ?? '').split(/\s+/).filter(Boolean);

/**
 * The wall writer's origin, folded into the SAME directives.
 *
 * A follower pane does two cross-origin things and CSP was blocking both. It
 * polls `${PUBLIC_WALL_ORIGIN}/api/wall` — blocked by `connect-src 'self'`,
 * which is not the silent failure the media ones are but IS a failure with no
 * visible cause on a kiosk with no console. And it plays media the writer
 * holds, which needed the origin in `media-src` too.
 *
 * Derived rather than asked for a second time: the wall origin is by
 * construction the origin holding the wall's media, so requiring an operator
 * to also name it in AERO_MEDIA_ORIGINS was one more way to half-configure a
 * wall. AERO_MEDIA_ORIGINS stays for what it is actually for — a real CDN.
 *
 * Same build-time trap as above: both are baked into the shell, so a value
 * that changes needs a rebuild, not a restart.
 */
const WALL_ORIGIN = (process.env.PUBLIC_WALL_ORIGIN ?? '').replace(/\/$/, '');
const PEER_ORIGINS = [...new Set([...MEDIA_ORIGINS, ...(WALL_ORIGIN ? [WALL_ORIGIN] : [])])];

export default defineConfig({
	...(IS_TEST ? { resolve: { conditions: ['browser', ...defaultServerConditions] } } : {}),
	plugins: [
		sveltekit({
			adapter: adapter(),
			/**
			 * ABSOLUTE asset paths. SvelteKit's default is relative, and relative
			 * breaks every route below the root.
			 *
			 * With `paths.relative` left at its default, the HTML shell links
			 * `./_app/immutable/...`. A browser resolves that against the CURRENT
			 * path, so `/` asks for `/_app/...` and works, while `/admin` asks for
			 * `/admin/_app/...` and gets a 404. The page then renders an empty
			 * `<body>` with a 200 and NOTHING in the console — no exception, no
			 * failed-module log — because the module that would have reported the
			 * error is the one that failed to load.
			 *
			 * That is the exact blank-cockpit failure `tools/smoke-routes.mjs` was
			 * written for, and it caught this one: `/` and `/wiki` passed while
			 * `/admin` rendered 14 characters. Every other check in the repo was
			 * green — 416 unit tests, a clean typecheck, no import cycles — because
			 * none of them loads a page below the root.
			 *
			 * Absolute is correct for this app regardless: it is served by
			 * adapter-node from a known origin, never from a subdirectory, so the
			 * portability relative paths buy is worth nothing here.
			 */
			paths: { relative: false },
			csp: {
				directives: {
					// GIBS and terrarium are fetched server-side, through /api/tiles —
					// the browser never talks to those hosts directly, so img-src and
					// connect-src need nothing beyond self.
					'default-src': ['self'],
					'script-src': ['self', 'unsafe-eval'],
					'style-src': ['self', 'unsafe-inline'],
					// `blob:` covers the slideshow; MEDIA_ORIGINS covers a remote one.
					'img-src': ['self', 'data:', 'blob:', ...PEER_ORIGINS],
					// Declared even when empty. Without the directive `media-src` falls
					// back to `default-src`, and the failure is a silent block with no
					// error event on the element — which is how this shipped broken.
					'media-src': ['self', 'blob:', 'data:', ...PEER_ORIGINS],
					// The wall poll is cross-origin on a follower pane. Only the wall
					// origin — a CDN has no business being fetched by this app.
					'connect-src': ['self', 'ws:', 'wss:', ...(WALL_ORIGIN ? [WALL_ORIGIN] : [])],
					'worker-src': ['self', 'blob:'],
					'child-src': ['blob:'],
					'font-src': ['self']
				}
			}
		})
	],
	// `svelte-maplibre-gl/vite` is REQUIRED for MapLibre GL JS v6+ — it calls
	// setWorkerUrl with `import 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'`.
	// The file exists; what fails is the dep optimizer, which cannot resolve a
	// query-suffixed subpath through maplibre-gl's `exports` map and dies with
	// UNLOADABLE_DEPENDENCY. Excluding the package leaves that import to Vite's
	// own worker handling, which understands `?worker&url`.
	//
	// Without this the dev server either refuses to boot or, worse, boots and
	// silently renders a map that builds a canvas and never fetches a tile.
	optimizeDeps: {
		exclude: ['svelte-maplibre-gl', 'maplibre-gl'],
		/**
		 * Under vitest the optimizer must bundle for NODE, not for a browser.
		 *
		 * The tests run in happy-dom, so the optimizer defaults to a browser
		 * platform and treats `node:` specifiers as unresolvable — including the
		 * `import { createRequire } from 'node:module'` that rolldown injects into
		 * its OWN runtime when it has to interop a CJS dependency. That is a
		 * startup error before a single test runs, and it is the failure that has
		 * held this job red since 2026-08-28.
		 *
		 * It only ever appeared on the Linux runner, never on darwin at the same
		 * lockfile and the same bun — both of which were checked before this. The
		 * platform is not a variable worth leaving implicit either way: vitest
		 * runs in node, so say node.
		 */
		...(IS_TEST ? { rollupOptions: { platform: 'node' as const } } : {})
	},
	server: {
		// Bind to 0.0.0.0 for LAN/kiosk access (Raspberry Pi deployment).
		host: true
	},
	build: {
		chunkSizeWarningLimit: 2000
	},
	test: {
		environment: 'happy-dom',
		include: ['tests/**/*.{test,spec}.{ts,svelte.ts}'],
		setupFiles: ['tests/setup.ts'],
		globals: false
	}
});
