#!/usr/bin/env python3
"""
generate-cloud-textures.py — procedural cumulus sprite textures.

The shipped webp puffs were low-res stock with block compression artifacts
and a hard black crop bar intruding on the smoke variant: stamped big near
the camera they read as blurry blocks, not cloud. These replace them with
seeded fractional-Brownian-motion billows: rotation-safe (radially
enveloped), fully transparent at the frame edge (no hard rect, sprites
rotate), and neutrally lit — the deck shader already does per-sprite solar
lighting, so baked shading here would double-light.

Deterministic: same seeds, same bytes. Regenerate with:
    python3 tools/generate-cloud-textures.py [--preview]

Writes aero-2/static/cloud.webp, cloud-dark.webp, cloud-smoke.webp
(--preview writes a contact sheet to /tmp instead and touches nothing).
"""

import argparse
import sys

import numpy as np
from PIL import Image

SIZE = 256
OCTAVES = 6


def value_noise(n: int, rng: np.random.Generator) -> np.ndarray:
    """One octave of value noise on an n+1 lattice, bilinearly upsampled."""
    grid = rng.random((n + 1, n + 1))
    t = np.linspace(0, n, SIZE)
    i0 = np.floor(t).astype(int)
    i1 = np.clip(i0 + 1, 0, n)
    f = t - np.floor(t)
    s = f * f * (3 - 2 * f)
    gx = grid[:, i0] * (1 - s) + grid[:, i1] * s
    return gx[i0, :] * (1 - s)[:, None] + gx[i1, :] * s[:, None]


def fbm(seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    acc = np.zeros((SIZE, SIZE))
    amp, freq, norm = 0.5, 4, 0.0
    for _ in range(OCTAVES):
        acc += amp * value_noise(freq, rng)
        norm += amp
        amp *= 0.5
        freq *= 2
    return acc / norm


def puff(seed: int, fill: float, edge_soft: float, core_rgb, rim_rgb) -> Image.Image:
    """fill: higher keeps more of the disc. edge_soft: wispy rim width."""
    base = fbm(seed)
    # Domain-warped second sample breaks the round-blob read.
    warp = fbm(seed + 7919)
    base = 0.70 * base + 0.30 * warp
    yy, xx = np.mgrid[0:SIZE, 0:SIZE]
    r = np.sqrt((xx - SIZE / 2) ** 2 + (yy - SIZE / 2) ** 2) / (SIZE / 2)
    density = base * (1 - 0.55 * r**2) - (1 - fill)
    alpha = np.clip(density / edge_soft, 0, 1)
    alpha = alpha * alpha * (3 - 2 * alpha)
    # Denser core reads darker: fake self-shadowing, radially symmetric so
    # sprite rotation cannot smear a light direction across the sky.
    core = np.clip(density / max(fill, 1e-3), 0, 1)
    core = core * core * (3 - 2 * core)
    core_rgb = np.asarray(core_rgb, dtype=float)
    rim_rgb = np.asarray(rim_rgb, dtype=float)
    rgb = rim_rgb[None, None, :] + (core_rgb - rim_rgb)[None, None, :] * core[:, :, None]
    out = np.dstack([rgb, alpha * 255]).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


PRESETS = {
    'cloud.webp': dict(seed=20260828, fill=0.66, edge_soft=0.22,
                       core_rgb=(244, 246, 250), rim_rgb=(255, 255, 255)),
    'cloud-dark.webp': dict(seed=771117, fill=0.66, edge_soft=0.26,
                            core_rgb=(148, 152, 165), rim_rgb=(208, 212, 222)),
    'cloud-smoke.webp': dict(seed=31337, fill=0.72, edge_soft=0.30,
                             core_rgb=(52, 54, 62), rim_rgb=(168, 170, 180)),
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--preview', action='store_true')
    ap.add_argument('--out', default='aero-2/static')
    args = ap.parse_args()

    made = {name: puff(**spec) for name, spec in PRESETS.items()}
    if args.preview:
        sheet = Image.new('RGBA', (SIZE * 3, SIZE), (10, 14, 22, 255))
        for i, img in enumerate(made.values()):
            sheet.paste(img, (i * SIZE, 0), img)
        sheet.save('/tmp/cloud-preview.png')
        print('preview -> /tmp/cloud-preview.png')
        return 0
    import os
    for name, img in made.items():
        path = os.path.join(args.out, name)
        img.save(path, 'WEBP', quality=92, method=6)
        print('wrote', path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
