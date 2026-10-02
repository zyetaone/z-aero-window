#!/usr/bin/env node
/**
 * Route-module export check.
 *
 * A `+server.ts` may only export an HTTP handler, a handful of SvelteKit
 * options, or a `_`-prefixed name. SvelteKit enforces this itself — but only
 * for `+server.ts`, only at postbuild analysis, and never in `svelte-check`.
 * So the shape of the failure is:
 *
 *     svelte-check       0 errors, 0 warnings
 *     check-repo         pass
 *     bun run build      Error: Invalid export 'MAX_BODY_BYTES' in /api/status
 *
 * which is correct and fast enough, but it costs a full production build to
 * discover one stray `export const`. This makes it a check-time failure instead.
 *
 * WHY IT IS WORTH ADDING ANYWAY — the build is not complete coverage:
 *
 * 1. `+page.ts` and `+layout.ts` are NOT validated at build. SvelteKit imports
 *    only `validate_server_exports` into its postbuild analysis
 *    (kit/src/core/postbuild/analyse.js); the page/layout validators run in
 *    the dev server and the client runtime. So a bad export from `+page.ts`
 *    reaches a production build unchallenged. This checks all five stems.
 * 2. `+page.server.ts` and `+layout.server.ts` are likewise unvalidated at
 *    build. This app HAS one — `admin/+page.server.ts` — so this is not a
 *    theoretical branch for it.
 *
 * THE ALLOWLIST IS NOT WRITTEN DOWN HERE, on purpose. The first version of this
 * check COPIED kit's sets into a local `RULES` table and documented that it had
 * copied them verbatim. It had not: the copy was missing `load`, which every
 * `+page.ts` and `+layout.ts` is allowed to export, and missing `QUERY`, which
 * kit 3 added to the `+server.ts` set. Nothing caught it, because the app it
 * shipped with exports only `ssr` and `csr` from its route modules and has no
 * `+page.server.ts` at all. Porting the check to an app that DOES export `load`
 * is what exposed it — a false positive that reads as a real failure, in a gate
 * whose entire job is to be trusted, is worse than no gate.
 *
 * So this now calls kit's OWN validators on each name, loaded from the installed
 * package. Two consequences that a copied table cannot give:
 *
 *   - it cannot drift: whatever the installed kit accepts, this accepts, and a
 *     kit upgrade that widens or narrows the set takes effect without an edit
 *     here. aero-1 on kit 2 rejects `QUERY`, this same script on kit 3 accepts
 *     it, and neither has to be told.
 *   - the failure message is kit's, including its hint about which file the
 *     name IS valid in, rather than a reconstruction of it.
 *
 * The import is a direct FILE path, not the `@sveltejs/kit/...` specifier:
 * kit's `exports` map exposes no wildcard for `src/utils/*`, so the specifier
 * is rejected, while a path into `node_modules` is governed by no exports map
 * at all. That dependency on kit's internal layout is deliberate and must fail
 * LOUDLY — if the file moves, this check exits non-zero and says why. A check
 * that quietly degrades to passing is indistinguishable from no check.
 *
 * ASTRONOMICAL NOTE, since it looks like the rule could be worked around: an
 * export is exempt when its name starts with `_`, and that exemption is
 * enforced by SvelteKit on the RESOLVED MODULE — not on what you wrote. So
 * `export { thing as _thing }` is accepted at build and then `thing` is missing
 * at runtime. This check cannot see through that, and neither can the type
 * checker. Keep route-module constants beside the schema they bound instead,
 * which is where they belong anyway.
 *
 * Run: node tools/check-route-exports.mjs
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripSource } from './lib/strip-comments.mjs';

const APP = new URL('..', import.meta.url).pathname;
const ROUTES = join(APP, 'src/routes');

/** kit's internal validator module — see the note above on why it is a path. */
const KIT_EXPORTS = join(APP, 'node_modules/@sveltejs/kit/src/utils/exports.js');
if (!existsSync(KIT_EXPORTS)) {
	console.error(
		'Route-module export check cannot start:\n' +
			`  not found: ${KIT_EXPORTS}\n\n` +
			'This check reads the export allowlist from the installed @sveltejs/kit rather\n' +
			'than keeping its own copy (a copied table drifted and produced a false\n' +
			'positive). If kit moved `src/utils/exports.js`, point this at the new file —\n' +
			'do not paste the sets back in, and do not delete the check.'
	);
	process.exit(1);
}

const kit = await import(pathToFileURL(KIT_EXPORTS).href);

/** Exact file stem → kit's validator for that module kind. */
const VALIDATORS = new Map([
	['+server', kit.validate_server_exports],
	['+page.server', kit.validate_page_server_exports],
	['+layout.server', kit.validate_layout_server_exports],
	['+page', kit.validate_page_exports],
	['+layout', kit.validate_layout_exports]
]);

function walk(dir) {
	const out = [];
	if (!existsSync(dir)) return out;
	for (const e of readdirSync(dir)) {
		const full = join(dir, e);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (basename(full).startsWith('+') && /\.(ts|js)$/.test(full)) out.push(full);
	}
	return out;
}

/** Exported names, in declaration form. Comments are stripped first so a
 *  commented-out `export const` is not counted — the same reason the source
 *  scanners do it: a docstring showing an example export is not an export. */
function exportsOf(src, file) {
	const code = stripSource(src, file);
	const names = new Set();
	// RUNTIME exports only. `export type X` and `export interface X` are erased
	// at compile time, so they never appear on the resolved module and
	// kit's validator cannot see them — verified: a +server.ts exporting a type
	// builds clean. Flagging them was this checker's first false positive, and
	// a gate that cries wolf on a legitimate export gets deleted.
	// `enum` IS runtime, so it stays.
	const re =
		/^\s*export\s+(?:async\s+)?(?:const|let|var|function\*?|class|enum)\s+([A-Za-z_$][\w$]*)/gm;
	for (const m of code.matchAll(re)) names.add(m[1]);
	// `export type { A, B }` and `export { type A }` are type-only too.
	for (const m of code.matchAll(/^\s*export\s+type\s*\{([^}]*)\}/gm)) void m;
	// `export { a, b as c }` — the exported alias is the one that matters.
	for (const m of code.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
		for (const part of m[1].split(',')) {
			const t = part.trim();
			// `export { type A }` is a type-only specifier and is erased.
			if (!t || /^type\s/.test(t)) continue;
			const as = /\bas\s+([A-Za-z_$][\w$]*)\s*$/.exec(t);
			names.add(as ? as[1] : t);
		}
	}
	return names;
}

const files = walk(ROUTES);
const violations = [];

for (const file of files) {
	const stem = basename(file).replace(/\.(ts|js)$/, '');
	const validate = VALIDATORS.get(stem);
	// Unknown `+…` module kinds are kit's business, not this check's.
	if (!validate) continue;
	const rel = file.replace(APP, '');
	for (const name of exportsOf(readFileSync(file, 'utf8'), file)) {
		if (name.startsWith('_')) continue;
		// kit's validator throws for anything outside its set for this stem —
		// the same function that rejects it in production, given a synthetic
		// module holding just this one name.
		try {
			validate({ [name]: true }, rel);
		} catch (err) {
			violations.push({ rel, name, message: err instanceof Error ? err.message : String(err) });
		}
	}
}

if (violations.length > 0) {
	console.error(`Route-module export check failed — ${violations.length} invalid export(s).\n`);
	for (const v of violations) {
		console.error(`  ${rel2(v.rel)} exports '${v.name}'`);
		console.error(`      ${v.message}`);
	}
	console.error(
		'\nA route module is not a place to put shared constants — SvelteKit refuses to\n' +
			'load one with an extra export. Move the constant beside the schema it bounds.'
	);
	process.exit(1);
}

console.log(
	`Route exports hold — ${files.length} route modules, every export is a handler or a SvelteKit option.`
);

/** Keep report paths short and app-relative. */
function rel2(rel) {
	return rel.startsWith('/') ? rel.slice(1) : rel;
}
