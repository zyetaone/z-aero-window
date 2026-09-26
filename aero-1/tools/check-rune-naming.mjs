#!/usr/bin/env node
/**
 * Rune-naming check.
 *
 * NEVER name a variable `state` when using `$state` — `state` collides
 * with the rune conceptually and in grep-ability. Use `model`, `engine`,
 * or `config`. Today zero files violate this; the check exists so the
 * first one fails loudly instead of becoming house style.
 *
 * Run: node tools/check-rune-naming.mjs
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APP = new URL('..', import.meta.url).pathname;

function walk(dir) {
	const out = [];
	if (!existsSync(dir)) return out;
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (/\.(ts|svelte)$/.test(e)) out.push(p);
	}
	return out;
}

const violations = [];
for (const file of walk(join(APP, 'src'))) {
	const hits = [];
	readFileSync(file, 'utf8')
		.split('\n')
		.forEach((line, i) => {
			const s = line.trim();
			if (s.startsWith('*') || s.startsWith('//')) return;
			if (/(let|const|var)\s+state\s*=\s*\$state/.test(s.split('//')[0])) hits.push(i + 1);
		});
	if (hits.length > 0) violations.push({ rel: file.slice(APP.length), hits });
}

if (violations.length > 0) {
	console.error('Variables named `state` holding $state:\n');
	for (const v of violations) {
		console.error(`  ${v.rel} (lines ${v.hits.join(', ')})`);
	}
	console.error('\nRename to `model`, `engine`, or `config`.');
	process.exit(1);
}

console.log('Rune naming holds — no $state variable named `state`.');
