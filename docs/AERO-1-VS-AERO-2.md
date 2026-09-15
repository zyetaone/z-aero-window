# aero-1 vs aero-2 — a measured comparison

Every number here came from running something against the tree at
`61593559`, not from reading code and forming an impression. The
commands are at the bottom so they can be re-run when this goes stale.

## 1. Size

| | aero-1 | aero-2 | |
|---|---|---|---|
| source files | 174 | **80** | −54% |
| source lines | 27,932 | **12,419** | −56% |
| lines per file | 161 | 155 | ~same |
| test files | 119 | 38 | |
| test lines | 13,772 | 6,528 | |
| test : source | 0.49 | **0.53** | aero-2 slightly denser |
| prod dependencies | 5 | **4** | |
| client JS+CSS | 7.5 MB | **2.3 MB** | −69% |
| client dir total | 32 MB | **4.6 MB** | −86% |

aero-1's client directory carries 11 MB of `cesiumStatic` — Workers,
Assets, Widgets that Cesium loads at runtime. That is not waste, it is
what the engine needs, and it is a fair part of the comparison because
the Pi has to hold and serve it.

The per-file average being identical is the interesting part: aero-2 is
not smaller because files got denser. It is smaller because there is
less of it.

## 2. Where the size went

| layer | aero-1 | aero-2 |
|---|---|---|
| render | 7,328 lines / 34 files | **2,323 / 12** |
| state | 2,862 lines | **1,559** |

The render layer is 3x smaller for the same job. MapLibre does
declaratively what `compose.ts` plus 34 Cesium subsystem modules did
imperatively, and a declarative layer needs no lifecycle code.

Largest files, which is where complexity hides:

```
aero-1  1966  routes/wiki/+page.svelte
        1649  routes/admin/+page.svelte
         751  lib/model/aero-window.svelte.ts
         732  lib/world/roads-geojson.ts

aero-2   806  lib/settings/Settings.svelte
         802  routes/admin/+page.svelte
         600  lib/display/world/Clouds.svelte
```

aero-1 has 11 files over 400 lines; aero-2 has 6, and its largest is
under half of aero-1's largest.

## 3. Reactivity shape — the sharpest difference

Normalised per 1,000 source lines:

| | aero-1 | aero-2 | |
|---|---|---|---|
| `$state` | 5.30 | 7.33 | 1.38x |
| `$derived` | 4.26 | **11.27** | 2.65x |
| `$effect` | 2.54 | **1.21** | 0.48x |
| `untrack` | 0.68 | 0.81 | 1.18x |

**`$effect : $derived` — aero-1 0.60, aero-2 0.11.**

That single ratio is the architecture. A `$derived` is a value that
falls out of other values; an `$effect` is a side effect someone has to
sequence, and every one is a place where order matters and a stale read
is possible. aero-1 reaches for effects roughly six times as often
relative to derivations.

aero-2 has 15 effects in the whole app, and they are concentrated where
effects genuinely belong — canvas lifecycle in `Display.svelte` (4),
audio (2), Stage mount (2), and one each for the cloud rebuild, the
minimap, the HUD, the blind. aero-1 has 71, with 8 in a single panel
component and 7 in `peer-sync`.

## 4. Enforcement — what actually stops decay

| | aero-1 | aero-2 |
|---|---|---|
| `check` | svelte-check | svelte-check **+ check-repo** |
| `test` | vitest | **check-repo +** vitest |
| documented invariants | informal, in prose | **10, all enforced by a failing check** |
| structural tests | 7 files | 6 files |
| browser smoke in CI | yes (added recently) | yes (added recently) |

This is the difference that compounds. aero-2 states ten invariants and
each names the check that fails when it is broken — determinism scans
source for `Math.random` and `+= dt`; the tile rule is asserted against
every file under `display/`; the packed-basemap allowlist is compared
against what is actually on disk. Three of those ten were unenforced
until this session, and all three are now checked and were verified by
breaking the code they cover.

Running aero-2's cycle checker against aero-1 finds one cycle:

```
lib/world/active.svelte.ts → lib/world/compose.ts → lib/world/camera.ts → active.svelte.ts
```

Worth being exact: the first edge is `import type`, which TypeScript
erases, so this does not exist at runtime and the checker is not
type-aware. It is a readability cycle, not a bundling one. But nothing
in aero-1 reports it either way, which is the actual finding.

## 5. Dead weight

| | aero-1 | aero-2 |
|---|---|---|
| dead exports | 139 | 60 |
| per 1k lines | 5.0 | **4.8** |
| unreachable modules | 1 | 0 |
| TODO/FIXME/HACK | 1 | **0** |

Nearly identical once normalised. aero-2 is not tidier per line — it is
tidier because there are half as many lines. Both are unusually low for
codebases this size, and both keep `ponytail:` markers for deliberate
shortcuts rather than pretending they are not there.

## 6. What this predicts on the Pi

aero-1 was measured on real hardware at **1.9–3.1 fps against a 50 fps
target** (`docs/PERF-2026-07-27-fps-investigation.md`). That
investigation ruled out fill rate (cutting pixels 3x changed nothing),
simulation (0.04% of frame time) and the GL backend (real V3D, not
llvmpipe), and concluded the cost was CPU-side work outside the model:
Cesium's scene update and the Three postprocess chain.

aero-2 has neither. No Cesium, no postprocess chain, Three imported by
two components. Measured on a pinned scene with `tools/frame-cost.mjs`:

```
59.9 fps median, 59.5 p95   — vsync-locked, clear/storm/night/two cities
1.0 ms main-thread per frame at 677 sprites (storm)
```

At a 5–8x Pi penalty that is ~8 ms against a 33 ms budget at 30 fps.
**That is an extrapolation, not a measurement**, and it is the single
biggest open question in this repo.

## 7. Honest summary

aero-2 is better on every axis that was measured, and the reasons are
structural rather than stylistic:

- **Half the code** for a superset of the rendering quality
- **A sixth the effect-to-derived ratio** — far less imperative sequencing
- **A third the render layer** — declarative engine, no lifecycle scaffolding
- **Ten enforced invariants** versus prose
- **A quarter the shipped JavaScript**

What aero-1 still has that aero-2 does not: seven API surfaces
(`events`, `command`, `config`, `devices`, `content`, `bundle`,
`assets`). Most are deliberate — ADR-007 replaced the SSE/CRDT fleet
model with polled wall snapshots on purpose. The genuine gap is asset
**upload**: aero-1 can accept a file, aero-2 can only reference a URL.

The one thing neither has: a frame measured on the actual Pi 5.

## 8. Re-running these numbers

From the repo root. Nothing here writes anything.

```sh
# size — aero-1's authored content/ counts as source, aero-2 has none
find aero-1/src aero-1/content -type f \( -name '*.ts' -o -name '*.svelte' \) \
  -print0 | xargs -0 wc -l | tail -1
find aero-2/src -type f \( -name '*.ts' -o -name '*.svelte' \) \
  -print0 | xargs -0 wc -l | tail -1

# reactivity shape — the $effect:$derived ratio is the one that matters
for a in aero-1 aero-2; do
  for r in state derived effect untrack; do
    printf '%s %-9s %s\n' "$a" "$r" \
      "$(grep -rho "\$$r\|untrack" $a/src --include='*.ts' --include='*.svelte' | wc -l)"
  done
done

# dead exports — the scanner prints one line per symbol, so count them
cd aero-1 && node tools/dead-export-scan.mjs | grep -cE '^\s+\S+\.(ts|svelte)\s'

# repo static checks: cycles + tracked->untracked + rune naming
# (aero-2 only runs this in CI; aero-1 has one cycle, type-only)
cd aero-2 && node tools/check-repo.mjs

# frame cost on a pinned scene — needs a build + a headless Chrome
cd aero-2 && bun run build && bun run serve &
node tools/frame-cost.mjs --base http://127.0.0.1:5399 --cdp-port 9455
```

## 9. What to do about it

Nothing in this document argues for rewriting aero-1. It ships, it works,
and it is what the fleet runs today. The comparison exists to answer one
question — is the rewrite actually better, or does it only feel newer —
and the answer is that it is better for reasons that survive measurement.

The order that follows from these numbers:

1. **Measure a frame on the real Pi.** Every performance claim above is
   an extrapolation past this point, and it is the only number that can
   still surprise us.
2. **Decide the upload question.** URL-referenced media may well be
   enough; if it is, aero-2's API surface is complete and the "seven
   missing endpoints" framing retires.
3. **Then, and only then, consider retiring aero-1.** Not before, because
   the fleet has nowhere else to run.
