# takram Atmosphere + Clouds Integration — Recipe

> **ARCHIVED — the takram stack is no longer in the codebase.**
>
> Removed 2026-04-23 during the Cesium re-consolidation (phase 8b,
> commit `970c146`). Both `/` and `/playground` now use Cesium's native
> sky + ocean post-process (waterMask + animated normals). CSS3D sprite
> clouds (`$lib/atmosphere/clouds/ArtsyClouds.svelte`) replaced the
> Bruneton volumetric path per the user's call that "CSS3D becomes the
> only cloud renderer on `/`."
>
> This doc is kept as a reference recipe so the takram + Threlte +
> pmndrs `postprocessing` integration can be rebuilt from scratch
> without re-discovering the non-obvious parts (pass order, async LUT
> init, render-loop takeover). Originally referenced
> `src/routes/playground2/layers/EffectStack.svelte` and
> `src/routes/playground/layers/EffectStack.svelte` — both deleted.
> Reconstruct from git history: `git log --all -- "**/EffectStack.svelte"`.
>
> **Paths in this recipe are historical.** They predate the `aero-1/` · `aero-2/`
> split and none of the `src/routes/playground*` files resolve today; they are
> left as written because the recipe is a record, not a map of the live tree.

## When to use this

- You want **physically correct Bruneton scattering** (colour of sky matches sun altitude, aerial perspective darkens distant terrain) and volumetric clouds that sit IN the atmosphere, not CSS sprites composited on top.
- You have a Three.js canvas that can own the render loop (Threlte `<Canvas>` overlay on top of MapLibre, or a standalone Three.js route).
- You accept the cost: ~80 KB (`@threlte/core`) + async LUT generation (~1 s startup latency) + one extra WebGL context if overlayed on MapLibre.

## When NOT to use this

- Single-context constraint (e.g. Pi 5 GL context budget). Use `@dvt3d/maplibre-three-plugin` + bare Three.js shaders instead (see `src/routes/playground/layers/WaterMesh.svelte`).
- You already have `PostProcessMount` (Three.js EffectComposer over MapLibre). Two composers racing over `autoRender` is a known failure mode — if you need takram effects, MERGE them into `PostProcessMount`, don't stack a second composer.

## Dependencies

```json
{
  "@threlte/core": "^8",
  "three": "^0.17x",
  "postprocessing": "^6",
  "@takram/three-atmosphere": "latest",
  "@takram/three-clouds": "latest",
  "@takram/three-geospatial": "latest",
  "@takram/three-geospatial-effects": "latest"
}
```

`Sky.js` from `three/addons/objects/Sky.js` is used for the analytical Hosek-Wilkie dome when Bruneton LUTs aren't ready yet (or as a cheaper fallback).

## Pass order (critical)

The composer is built inside a Threlte `<Canvas>`. Build it once at mount; add passes conditionally based on prop flags. Passes MUST be added in this order — AerialPerspective reads the cloud overlay each frame.

```
RenderPass(scene, camera)
  → EffectPass(camera, CloudsEffect)          [if enableClouds]
  → EffectPass(camera, AerialPerspectiveEffect) [if enableClouds]
  → EffectPass(camera, BloomEffect, LensFlareEffect, DitheringEffect) [if enablePostfx]
  → OutputPass (implicit at composer end)
```

The Clouds → Aerial → Bloom ordering is non-negotiable. Aerial eats the cloud composite as its `overlay`/`shadow` hooks; Bloom runs on the final lit scene.

## Render-loop takeover

Threlte renders on-demand. takram expects a continuous loop. Two composers can't both own `autoRender` — pick one:

```typescript
const { renderer, scene, camera, size, autoRender, invalidate, renderStage } = useThrelte();

const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType });
composer.addPass(new RenderPass(scene, camera.current));
// ...addPass ordering above...

const prevAutoRender = autoRender.current;
autoRender.set(false); // take over

useTask(
  (delta) => {
    // resize guard
    if (size.current.width !== lastW || size.current.height !== lastH) {
      composer.setSize(size.current.width, size.current.height);
    }
    // wire cloud → aerial hooks each frame (they're Vector3/float fields)
    aerial.overlay = clouds.atmosphereOverlay;
    aerial.shadow = clouds.atmosphereShadow;
    aerial.shadowLength = clouds.atmosphereShadowLength;
    // drive sun
    const sun = sunVectorForSky(sceneState.timeOfDay, sceneState.lat);
    clouds.sunDirection.copy(sun);
    aerial.sunDirection.copy(sun);
    composer.render(delta);
  },
  { stage: renderStage, autoInvalidate: false },
);

onDestroy(() => {
  autoRender.set(prevAutoRender);
  composer.dispose();
  clouds?.dispose();
  aerial?.dispose();
});
```

`autoInvalidate: false` is load-bearing — without it Threlte idles the loop and the composer stops rendering.

## Async LUT init (~1 s)

`PrecomputedTexturesGenerator(renderer).update()` generates irradiance + scattering + transmittance 3D textures. Gate cloud rendering until they're ready:

```typescript
clouds.skipRendering = true; // set BEFORE first composer.render()

async function initAtmosphere() {
  const [localWeather, shape, shapeDetail, turbulence, stbn] = await Promise.all([
    load2D(DEFAULT_LOCAL_WEATHER_URL),
    load3D(DEFAULT_SHAPE_URL, CLOUD_SHAPE_TEXTURE_SIZE),
    load3D(DEFAULT_SHAPE_DETAIL_URL, CLOUD_SHAPE_DETAIL_TEXTURE_SIZE),
    load2D(DEFAULT_TURBULENCE_URL),
    loadSTBN(DEFAULT_STBN_URL),
  ]);

  clouds.localWeatherTexture = localWeather;
  clouds.shapeTexture = shape;
  clouds.shapeDetailTexture = shapeDetail;
  clouds.turbulenceTexture = turbulence;
  clouds.stbnTexture = stbn;

  const gen = new PrecomputedTexturesGenerator(renderer);
  const luts = await gen.update();

  clouds.irradianceTexture = luts.irradianceTexture;
  clouds.scatteringTexture = luts.scatteringTexture;
  clouds.transmittanceTexture = luts.transmittanceTexture;
  clouds.singleMieScatteringTexture = luts.singleMieScatteringTexture ?? null;
  clouds.higherOrderScatteringTexture = luts.higherOrderScatteringTexture ?? null;

  aerial.irradianceTexture = luts.irradianceTexture;
  aerial.scatteringTexture = luts.scatteringTexture;
  aerial.transmittanceTexture = luts.transmittanceTexture;

  clouds.skipRendering = false;
  invalidate();
}
```

**Cancellation**: if the parent unmounts mid-init, the promise callback fires on disposed textures. Guard with a mount-flag check before assigning to `clouds.*`, or wrap `initAtmosphere` in an `AbortController`.

## Aerial settings for MapLibre overlay

When Aerial runs ON TOP of a visible MapLibre globe (Threlte Canvas stacked via `position: absolute`):

```typescript
aerial.sky = false;       // don't occlude the map — MapLibre owns the sky base
aerial.sunLight = true;
aerial.skyLight = true;
```

When Aerial runs as the only sky (no MapLibre underneath): `sky = true`.

## Tone mapping

AgX when postfx is active:

```typescript
const prevToneMapping = renderer.toneMapping;
const prevExposure = renderer.toneMappingExposure;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.0;
// restore in onDestroy
```

## Sky.js hemisphere-discard trick (for cheap analytical sky)

If you need a sky dome but not full Bruneton + clouds (e.g. as a fallback while LUTs load, or for low-power devices), `three/addons/objects/Sky.js` can be made transparent below the horizon via `onBeforeCompile`:

```typescript
const sky = new Sky();
sky.scale.setScalar(450_000);
sky.material.onBeforeCompile = (shader) => {
  shader.fragmentShader = shader.fragmentShader.replace(
    'vec3 direction = normalize( vWorldPosition - cameraPosition );',
    `vec3 direction = normalize( vWorldPosition - cameraPosition );
     if (direction.y < -0.01) discard;`,
  );
};
sky.material.transparent = true;
sky.material.depthWrite = false;
sky.renderOrder = -100;
```

With the Threlte Canvas cleared to alpha 0, discarded pixels stay transparent and whatever sits below (MapLibre, DOM, etc.) shows through. Baseline uniforms that match our window aesthetic:

```typescript
u.turbidity.value = 2.2;
u.rayleigh.value = 3.0;
u.mieCoefficient.value = 0.004;
u.mieDirectionalG.value = 0.82;
```

## Sun driver

Both Clouds and Aerial expect a `sunDirection: Vector3`. Compute it from time-of-day + latitude. The SSOT is `src/routes/playground/lib/sun-math.ts` (ported from `playground2/lib/sun.svelte.ts`) — use `sunVectorForSky(timeOfDay, lat)`.

## Known failure modes

1. **Two EffectComposers racing.** If another component (like `PostProcessMount`) also calls `autoRender.set(false)` and runs its own `composer.render()`, whichever mounts last wins, the other goes dark. Fix: one composer per scene. Always.
2. **Missing `autoInvalidate: false` on `useTask`.** Threlte stops ticking the loop when nothing reactive changes. Without this flag, composer renders drop to zero.
3. **Aerial overlay hooks lost on prop change.** `aerial.overlay = clouds.atmosphereOverlay` MUST be re-assigned each frame in the `useTask` callback. These fields are plain references, not reactive.
4. **LUT disposal after unmount.** If init resolves after `onDestroy`, assignment to `clouds.irradianceTexture` throws. Use an `isMounted` guard or abort the promise.
5. **AgX tone mapping persisting after unmount.** Capture + restore `renderer.toneMapping` in `onDestroy`.

## Related files

- `src/routes/playground2/layers/EffectStack.svelte` — working implementation (scheduled for archival)
- `src/routes/playground2/layers/SkyDome.svelte` — Sky.js hemisphere-discard
- `src/routes/playground/lib/sun-math.ts` — sun direction driver
- `src/routes/playground/layers/MapScene.svelte` — the single-context alternative (no takram)
- `src/routes/playground/layers/WaterMesh.svelte` — first per-feature-class Three.js mesh inside MapLibre GL

## If you need to restore this stack

1. Add the takram + postprocessing + @threlte/core deps.
2. Copy the original `EffectStack.svelte` from git history (commit the archival notes in the branch message).
3. Rebuild `PostProcessMount` to fold takram's `AerialPerspectiveEffect` into its existing composer — DO NOT stack a second one.
4. Wire `clouds.sunDirection` / `aerial.sunDirection` off `sun-math.ts`.
