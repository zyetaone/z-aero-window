/**
 * roads-paint.ts — the split between what MapLibre may see change and what
 * it must not.
 *
 * WHY THIS EXISTS. `Roads.svelte` drives six `line-opacity` values off the
 * wall clock: a 5 Hz lamp shimmer, an altitude fade, a cloud-deck loss. Each
 * used to be an expression, `['*', 0.55 * glow, flicker, viirsGlow]`, with
 * the per-road VIIRS gain (`['get', 'glow']`) inside it. Any expression that
 * reads a feature property is DATA-DRIVEN, and in maplibre-gl 6.6.0
 * `StyleLayer.setPaintProperty` returns
 * `newValue.isDataDriven() || wasDataDriven || isCrossFadedProperty`; a true
 * sends `Style._updateLayer`, which marks the layer's source `"reload"` and
 * pauses its tile manager. So every shimmer step and every altitude tick
 * re-tiled the whole `city-roads` GeoJSON — Denver is 19,838 features — five
 * times a second, on a Pi, for a change of a few percent in opacity.
 *
 * The fix is a division of labour, not a smaller number:
 *
 * - The per-feature gain lives in `line-color`, as the ALPHA of a static
 *   expression that never changes after mount. MapLibre premultiplies colour
 *   by alpha and then by `line-opacity` in the line shader, so
 *   `colour.a * opacity` is exactly the old `opacity * viirsGlow` product —
 *   lamps still burn full downtown and ember in the dark prairie.
 * - Every reactive scalar is a PLAIN NUMBER on `line-opacity`. Old and new
 *   values are both constant, `setPaintProperty` returns false, and the
 *   change is a uniform update: no worker, no reload.
 *
 * Two things make this cheap in practice and are worth knowing when the
 * layer is next touched. svelte-maplibre-gl's `RawLayer` diffs paint by
 * `prevPaint[key] !== value` after a `$state.snapshot`, which deep-clones
 * arrays — so the static colour IS re-sent on every paint change, and only
 * `deepEqual` at the top of `Style.setPaintProperty` drops it. That is fine,
 * it is the same short-circuit `line-width` has always relied on. And a
 * plain-number opacity inherits MapLibre's default 300 ms paint transition
 * (data-driven values never transitioned), which would ease each 5 Hz step
 * toward a target it never reaches and flatten the flicker; `SNAP` below is
 * set on every lamp layer so the shimmer still steps the way it did.
 *
 * Pure so the contract is testable without a map: colours carry the gain,
 * opacities are numbers on the 0.01 grid (equal primitives do not notify a
 * `$derived`, so a scalar that only changes on the grid is one paint write
 * per step, not per frame).
 */
import { quantize } from './beat.js';

/** A MapLibre style expression. Typed loosely: the spec types are not exported for authoring. */
export type PaintExpression = readonly unknown[];

/**
 * Per-road VIIRS gain, stamped offline by tools/stamp-road-glow.mjs.
 * Lamp-runs through bright ground burn full; rural connectors dim toward
 * ember. Unstamped packs read 1 — the old flat look, not dark.
 */
export const VIIRS_GLOW: PaintExpression = ['coalesce', ['get', 'glow'], 1];

/** `#rrggbb` → the three channels. Six-digit hex only; that is all the palette uses. */
function hexToRgb(hex: string): [number, number, number] {
	const m = /^#([0-9a-f]{6})$/i.exec(hex);
	if (!m) throw new Error(`roads-paint: expected #rrggbb, got ${hex}`);
	const n = parseInt(m[1], 16);
	return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** The colour with the VIIRS gain as its alpha: a static, data-driven expression. */
export function withViirsAlpha(hex: string): PaintExpression {
	const [r, g, b] = hexToRgb(hex);
	return ['rgba', r, g, b, VIIRS_GLOW];
}

/**
 * Sodium amber for the big roads, cooler white for the small grid, each
 * carrying the per-road gain in its alpha (see `withViirsAlpha`).
 *
 * Backwards from the intuition that motorways are the modern LED ones, and
 * deliberately so: from altitude the arterials are the continuous lit runs
 * and the residential grid reads as scattered cooler points. Picking the
 * warm tone for the DOMINANT line keeps the overall cast matching VIIRS
 * underneath, which is strongly amber. Two vector colours against one
 * raster colour is already the limit of what stays coherent.
 */
export const LAMP_COLOR: PaintExpression = [
	'match',
	['get', 'class'],
	'motorway',
	withViirsAlpha('#ffb959'),
	'trunk',
	withViirsAlpha('#ffab45'),
	'primary',
	withViirsAlpha('#ffa63c'),
	withViirsAlpha('#e8d9c0')
];

/** Dark roadbed casing, VIIRS-weighted like the lamps it sits under. */
export const CASING_COLOR: PaintExpression = withViirsAlpha('#17110b');

/**
 * No paint transition on the lamp opacities. The 5 Hz shimmer is a step
 * function by design (`lampFlicker`), and the old data-driven expressions
 * never transitioned; a 300 ms ease under a 200 ms step would smear it.
 */
export const SNAP = { duration: 0 } as const;

/**
 * A `line-opacity` value: the product of the reactive scalars, clamped and
 * quantised. Always a finite number in 0..1 — that is the whole contract.
 *
 * The NaN guard is not decoration. `Math.min(1, NaN)` is NaN and
 * `Math.round(NaN)` is NaN, so without it a single non-finite input propagates
 * straight into a `line-opacity` paint expression, and MapLibre's response to a
 * NaN expression is to drop the layer — the road lamps silently vanish rather
 * than throwing. Every comparable function in this tree already guards
 * (`farFieldShare`, `gradeWarm`, `downtownWarpSec`); this one did not, and its
 * docstring claimed a guarantee the tests never exercised.
 */
export function lampOpacity(...factors: number[]): number {
	if (!factors.every((f) => Number.isFinite(f))) return 0;
	const product = factors.reduce((a, b) => a * b, 1);
	return quantize(Math.max(0, Math.min(1, product)));
}
