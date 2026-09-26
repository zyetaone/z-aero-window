#!/usr/bin/env node
/**
 * Cesium-isolation check (architectural invariant #1).
 *
 * Only `src/lib/world/CesiumViewer.svelte` may hold a RUNTIME reference to
 * the `cesium` package — the dynamic `import('cesium')`. Every other module
 * references Cesium as a type only (`import type`), which erases at build
 * and keeps the kiosk's Cesium payload behind the single async chunk.
 *
 * A value import anywhere else would drag the whole engine into the
 * synchronous module graph (and the route-split admin/lab chunks).
 *
 * Run: node tools/check-cesium-isolation.mjs
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APP = new URL('..', import.meta.url).pathname;
const OWNER = join(APP, 'src/lib/world/CesiumViewer.svelte');

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

/** Value (non-erased) references to the 'cesium' package in one file. */
function runtimeCesiumRefs(src) {
	const hits = [];
	// `import type ... from 'cesium'` is erased — skip it.
	for (const m of src.matchAll(/\bimport\b(\s+type\b)?\s*([^;'"]*?)\bfrom\s*['"]cesium['"]/g)) {
		if (m[1]) continue;
		const body = (m[2] ?? '').trim();
		if (body.startsWith('{')) {
			const specs = body
				.slice(1, body.lastIndexOf('}'))
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			if (specs.length > 0 && specs.every((s) => /^\s*type\b/.test(s))) continue;
		}
		hits.push(m[0].split('\n')[0].trim());
	}
	// Dynamic imports always execute.
	for (const m of src.matchAll(/\bimport\(\s*['"]cesium['"]\s*\)/g)) hits.push(m[0]);
	return hits;
}

const violations = [];
for (const file of [...walk(join(APP, 'src')), ...walk(join(APP, 'content'))]) {
	if (file === OWNER) continue;
	const refs = runtimeCesiumRefs(readFileSync(file, 'utf8'));
	if (refs.length > 0) violations.push({ file: file.slice(APP.length), refs });
}

if (violations.length > 0) {
	console.error('Runtime cesium imports outside CesiumViewer.svelte:\n');
	for (const v of violations) {
		console.error(`  ${v.file}`);
		for (const r of v.refs) console.error(`    ${r}`);
		console.error('');
	}
	console.error(
		`${violations.length} file(s) — keep runtime cesium in CesiumViewer.svelte; use \`import type\` elsewhere.`
	);
	process.exit(1);
}

console.log('Cesium isolation holds — runtime cesium lives only in CesiumViewer.svelte.');
