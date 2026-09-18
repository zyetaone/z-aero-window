# CLAUDE.md

**This file is intentionally a pointer.** The canonical agent instructions
live in [`AGENTS.md`](AGENTS.md), which every agent harness reads.

Maintaining two overlapping instruction files guaranteed drift: as of
2026-08-02 this one still described `world-three/`, `world-lighting/`,
`scene/registry.ts`, and a `Compositor.svelte` that no longer exist.

**Two apps, and the root is neither.** `aero-1/` is what the Pi fleet runs;
`aero-2/` is the pre-ship rewrite. The repo root has no `package.json`, so
every `bun run ...` must be run from one of those two directories. Root
`AGENTS.md` describes **aero-1** unless a section says otherwise.

- Agent instructions → `AGENTS.md` (aero-1) · `aero-2/AGENTS.md` (aero-2)
- Architecture → `docs/ARCHITECTURE.md`
- Module maps → `docs/CODEMAPS/INDEX.md`
- Phase history (was here) → `docs/PHASE-HISTORY.md`
