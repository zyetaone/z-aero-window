#!/usr/bin/env node
/**
 * Route-module export check.
 *
 * A `+server.ts` may only export an HTTP handler, a handful of SvelteKit
 * options, or a `_`-prefixed name. SvelteKit enforces this itself — but only
 * for `+server.ts`, only at postbuild analysis, and never in `svelte-check`.
 * So the shape of the failure is:
 *
 *     svelte-check      0 errors, 0 warnings
 *     check-cycles       pass
 *     check-rune-naming  pass
 *     bun run build      Error: Invalid export 'MAX_BODY_BYTES' in /api/status
 *
 * which is correct and fast enough, but it costs a full production build to
 * discover one stray `export const`. This makes it a check-time failure instead.
 *
 * WHY IT IS WORTH ADDING ANYWAY — the build is not complete coverage:
 *
 * 1. `+page.ts` and `+layout.ts` are NOT validated at build. SvelteKit imports
 *    only `validate_server_exports` into its postbuild analysis
 *    (kit/src/core/postbuild/analyse.js:183); the page/layout validators run in
 *    the dev server and the client runtime. So a bad export from `+page.ts`
 *    reaches a production build unchallenged. This checks all three.
 * 2. `+page.server.ts` and `+layout.server.ts` are likewise unvalidated at
 *    build. This app has neither today, but the checker covers them the day
 *    someone adds one.
 * 3. The allowlists below are COPIED from SvelteKit's own
 *    `kit/src/utils/exports.js`, not guessed. If a future SvelteKit version
 *    widens them, this check is wrong in the safe direction (it reports an
 *    export SvelteKit would have accepted) rather than the dangerous one.
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
import { stripSource } from './lib/strip-comments.mjs';

const APP = new URL('..', import.meta.url).pathname;
const ROUTES = join(APP, 'src/routes');

// Copied verbatim from @sveltejs/kit/src/utils/exports.js.
const HTTP = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'fallback'];
const LAYOUT_OPTS = ['prerender', 'csr', 'ssr', 'trailingSlash', 'config'];
const RULES = {
	'server': { files: '+server', allow: [...HTTP, 'prerender', 'trailingSlash', 'config', 'entries'] },
	'page': { files: '+page', allow: [...LAYOUT_OPTS, 'entries'] },
	'layout': { files: '+layout', allow: [...LAYOUT_OPTS] }
};

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
	// SvelteKit's validator cannot see them — verified: a +server.ts exporting a
	// type builds clean. Flagging them was this checker's first false positive,
	// and a gate that cries wolf on a legitimate export gets deleted.
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
	const base = basename(file);
	const kind = Object.keys(RULES).find((k) => base.startsWith(RULES[k].files));
	if (!kind) continue;
	// `+page.ts` and `+page.server.ts` are different files with different
	// allowlists; only match the exact stem so `+page.server` is not read as
	// `+page`.
	const stem = base.replace(/\.(ts|js)$/, '');
	if (stem !== RULES[kind].files && stem !== `${RULES[kind].files}.server`) continue;
	const allow = new Set(
		stem.endsWith('.server') && kind === 'page'
			? [...LAYOUT_OPTS, 'actions', 'entries']
			: stem.endsWith('.server') && kind === 'layout'
				? [...LAYOUT_OPTS]
				: RULES[kind].allow
	);
	for (const name of exportsOf(readFileSync(file, 'utf8'), file)) {
		if (name.startsWith('_') || allow.has(name)) continue;
		const rel = file.replace(APP, '');
		violations.push({ rel, name, allow: [...allow].join(', ') });
	}
}

if (violations.length > 0) {
	console.error(`Route-module export check failed — ${violations.length} invalid export(s).\n`);
	for (const v of violations) {
		console.error(`  ${v.rel} exports '${v.name}'`);
		console.error(`      valid here: ${v.allow}, or any '_'-prefixed name`);
	}
	console.error(
		'\nA route module is not a place to put shared constants — SvelteKit refuses to\n' +
			'load one with an extra export. Move the constant beside the schema it bounds.'
	);
	process.exit(1);
}

console.log(
	`Route exports hold — ${files.length} route modules, all exports are handlers or SvelteKit options.`
);
