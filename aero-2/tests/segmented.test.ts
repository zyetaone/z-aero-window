import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LOCATIONS } from '#lib/locations.js';
import { SCENE_PRESETS } from '#lib/settings/presets.js';
import { WEATHERS } from '#lib/wall.js';
import { FLEET_ROLES, AUDIO_MODES } from '#lib/settings/settings.svelte.js';

/**
 * `Segmented` keyed its `{#each}` on `String(option)` until 2026-09-03. That is
 * `"[object Object]"` for every element of an object array, so passing
 * `LOCATIONS` threw `each_key_duplicate` during render and took the WHOLE
 * settings drawer down to "Internal Error" — both tabs — the moment an operator
 * pressed `s`.
 *
 * Nothing could see it: a runtime throw inside an `{#each}` is invisible to
 * `svelte-check`, no unit test mounted the drawer, and the smoke run loaded `/`
 * without pressing anything. The kiosk looked perfect.
 *
 * The key now defaults to the option ITSELF, which is correct for the
 * module-level constant arrays this component is given — their elements are
 * stable for the life of the page, so identity works. These tests hold that
 * assumption up rather than trusting it, because it is the assumption that
 * broke.
 */
describe('Segmented option arrays can actually be keyed', () => {
	const CALLER_ARRAYS: Record<string, readonly unknown[]> = {
		LOCATIONS,
		WEATHERS,
		FLEET_ROLES,
		AUDIO_MODES,
		'preset ids': ['', ...SCENE_PRESETS.map((p) => p.id)],
		'display modes': ['flight', 'video', 'screensaver', 'standby']
	};

	it('every array passed to Segmented is unique by identity', () => {
		for (const [name, arr] of Object.entries(CALLER_ARRAYS)) {
			expect(new Set(arr).size, `${name} has duplicate elements by identity`).toBe(arr.length);
		}
	});

	/**
	 * The specific failure: object arrays are NOT unique once stringified, so a
	 * key of `String(option)` collapses them. This is the assertion that would
	 * have caught the original bug, stated as a property of the data rather than
	 * of the component.
	 */
	it('object arrays collapse under String() — so identity keying is load-bearing', () => {
		const stringified = new Set(LOCATIONS.map(String));
		expect(stringified.size, 'LOCATIONS no longer collapses; the hazard has changed shape').toBe(1);
		expect(LOCATIONS.length).toBeGreaterThan(1);
	});

	/**
	 * A caller that builds its options inline gets a fresh array each render, so
	 * identity keying would thrash. `Wall.svelte` does exactly that for
	 * destinations and passes an explicit `key`; this asserts the rule rather
	 * than the instance — any caller handing Segmented a non-primitive array must
	 * supply one.
	 */
	it('every object-array caller passes an explicit key', () => {
		for (const file of ['src/lib/settings/Settings.svelte', 'src/lib/settings/Wall.svelte']) {
			const src = readFileSync(file, 'utf8');
			const blocks = src.split('<Segmented').slice(1);
			for (const block of blocks) {
				const body = block.slice(0, block.indexOf('/>'));
				const opts = /options=\{([^}]*)\}/.exec(body)?.[1]?.trim() ?? '';
				// Primitive-union arrays are safe under identity keying.
				const isPrimitive =
					/^(WEATHERS|DISPLAY_MODES|FLEET_ROLES|AUDIO_MODES)$/.test(opts) ||
					opts.startsWith('[') ||
					opts.includes('.map((p) => p.id)');
				if (isPrimitive) continue;
				expect(
					body,
					`${file}: <Segmented options={${opts}}> passes objects without a key — ` +
						'identity keying breaks the moment that array is rebuilt per render'
				).toMatch(/\bkey=\{/);
			}
		}
	});
});
