import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PRODUCT_NAME, PRODUCT_OWNER, ENGINEERED_BY, PRODUCT_PARTNERS } from '#lib/credits.js';

/**
 * Attribution that is declared but rendered nowhere is not attribution.
 *
 * `PRODUCT_PARTNERS` carried Zyeta and SWA behind a comment reading "shown on
 * the boot lockup" — true of v1, which has `shell/BootLockup.svelte`. The
 * rewrite has no boot lockup, so the constant was exported, typed, and
 * displayed on no surface at all. SWA appeared nowhere in the product it is a
 * partner on, and nothing failed, because a constant nobody reads is
 * indistinguishable from one nobody needs.
 *
 * This is the third instance of that shape found in aero-2 (the VIIRS layer
 * that was packed and unmounted, the fps field that was parsed and averaged and
 * always an em-dash), which is why it is worth a check rather than a fix.
 *
 * Asserts the SOURCE renders it, not a mounted DOM: these are static footers,
 * and a string in the template is exactly the thing that went missing.
 *
 * The `<script>` block is stripped before matching, and that is the point. A
 * first version of this checked the whole file and passed after the footer line
 * was deleted, because the IMPORT still named the constant — a test that proves
 * a symbol was imported, not that anyone displays it, which is precisely the
 * bug it was written for. Verified by deleting the line again.
 */
const surfaces = {
	'admin cockpit': 'src/routes/admin/+page.svelte',
	wiki: 'src/routes/wiki/+page.svelte'
};

/** Markup only — an import is not a render. */
function template(path: string): string {
	return readFileSync(path, 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
}

describe('product attribution reaches a surface', () => {
	for (const [label, path] of Object.entries(surfaces)) {
		it(`${label} renders owner, engineer and partners`, () => {
			const src = template(path);
			expect(src, `${label} does not name the owner`).toContain('PRODUCT_OWNER');
			expect(src, `${label} does not name the engineer`).toContain('ENGINEERED_BY');
			expect(src, `${label} declares no partners — SWA appears nowhere on this surface`).toContain(
				'PRODUCT_PARTNERS'
			);
		});
	}

	/**
	 * The kiosk must NOT carry them, and that is a product rule rather than an
	 * oversight: the passenger window is a window, and the moment it wears a
	 * logo it stops being one. The operator surfaces above are where a client's
	 * name belongs.
	 */
	it('keeps attribution off the passenger window', () => {
		const kiosk = template('src/routes/+page.svelte');
		expect(kiosk).not.toContain('PRODUCT_PARTNERS');
		expect(kiosk).not.toContain('ENGINEERED_BY');
	});

	it('has no empty attribution values', () => {
		for (const [name, value] of Object.entries({
			PRODUCT_NAME,
			PRODUCT_OWNER,
			ENGINEERED_BY
		})) {
			expect(value.trim().length, `${name} is blank`).toBeGreaterThan(0);
		}
		expect(PRODUCT_PARTNERS.length).toBeGreaterThan(0);
		for (const p of PRODUCT_PARTNERS) expect(p.trim().length).toBeGreaterThan(0);
	});
});
