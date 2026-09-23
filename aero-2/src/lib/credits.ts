/**
 * Product attribution — SSOT for on-screen + docs copy.
 *
 * Aero Dynamic Window is a Zyeta product. Engine and architecture by
 * rdtect (Rick / rdtect systems). Keep this module free of runes and
 * DOM so server routes, wiki, and kiosk can all import it.
 */

export const PRODUCT_NAME = 'Aero Dynamic Window';
export const PRODUCT_SHORT = 'Aero Window';

/** Commercial product owner / fleet operator brand. */
export const PRODUCT_OWNER = 'Zyeta';

/** Engine, architecture, and systems engineering. */
export const ENGINEERED_BY = 'rdtect';

/**
 * Install partners, shown wherever the product is attributed.
 *
 * The comment here used to say "shown on the boot lockup", which was true of
 * v1 — `shell/BootLockup.svelte`. The rewrite has no boot lockup, so this
 * constant was declared, typed, exported and rendered NOWHERE: SWA appeared on
 * no surface in the product it is a partner on. Same shape as the fps field
 * that was parsed and averaged and always displayed as an em-dash.
 *
 * Now rendered on the two surfaces that already carry attribution, the admin
 * cockpit and the wiki footer. Deliberately NOT on the kiosk: the passenger
 * window is a window, and the moment it carries a logo it stops being one.
 */
export const PRODUCT_PARTNERS = ['Zyeta', 'SWA'] as const;

export const PRODUCT_YEAR = 2026;

/**
 * Release stage, shown on OPERATOR surfaces only (admin, wiki) — never on the
 * window itself.
 */
export const PRODUCT_STAGE: string | null = 'Beta';

/** Slightly longer credit for wiki / architecture surfaces. */
export const PRODUCT_CREDIT_BLURB = `${PRODUCT_SHORT} is a ${PRODUCT_OWNER} product. Engine, architecture, and fleet systems by ${ENGINEERED_BY}.`;
