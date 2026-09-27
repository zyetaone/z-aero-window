# State API Reference

> **Historical reference — the file it documents no longer exists.**
> `src/lib/app-state.svelte.ts` *(removed)* and `src/lib/simulation/` *(removed)* were replaced by
> `aero-1/src/lib/model/aero-window.svelte.ts` (root state) and
> `aero-1/src/lib/model/config-tree.svelte.ts` (the SSOT for every tunable number).
> Treat the rune *patterns* below as still-valid illustrations, but verify every
> import path and API name against `aero-1/src/lib/model/` before copying anything.

Quick reference for the state architecture using Svelte 5 runes.

## Import

```typescript
import { useAeroWindow, createAeroWindow, LOCATIONS, WEATHER_EFFECTS, type LocationId } from '$lib/core';
```

## Root Component Setup

```typescript
// In +page.svelte
const model = createAeroWindow();
```

## Child Component Access

```typescript
// In any child component
const model = useAeroWindow();
```

## Extracted Modules

The core is decomposed into focused files:

| Module | Export | Purpose |
|--------|--------|---------|
| `types.ts` | `SkyState`, `LocationId`, `WeatherType`, `Location` | Shared type definitions |
| `locations.ts` | `LOCATIONS`, `LOCATION_IDS`, `LOCATION_MAP` | Location presets and lookup |
| `persistence.ts` | `loadPersistedState`, `savePersistedState`, `safeNum` | localStorage save/load |
| `weather-effects.ts` | `WEATHER_EFFECTS` | Centralized weather→visual lookup map |
| `constants.ts` | `AIRCRAFT`, `ATMOSPHERE`, `BLIND`, `CESIUM`, `FLIGHT_FEEL`, `AMBIENT`, `UNITS` | Tuning constants |

All re-exported through `$lib/core/index.ts`.

## AeroWindow API (Simulation)

### Position & Camera

```typescript
model.lat: number           // Latitude
model.lon: number           // Longitude
model.utcOffset: number     // Hours from UTC for location timezone
model.altitude: number      // Altitude in feet (10k-65k)
model.heading: number       // Compass heading (0-360)
model.pitch: number         // Camera pitch angle
```

### Time

```typescript
model.timeOfDay: number        // Hour of day (0-24, decimal)
model.syncToRealTime: boolean  // Auto-sync with system time
```

### Location

```typescript
model.location: LocationId     // Current location preset
```

### Environment

```typescript
model.weather: WeatherType     // 'clear' | 'cloudy' | 'overcast' | 'storm'
model.cloudDensity: number     // 0-1
model.cloudSpeed: number       // Drift speed multiplier
model.cloudScale: number       // Cloud size multiplier
model.haze: number             // 0-0.15
```

### Night Rendering

```typescript
model.nightLightIntensity: number  // City lights brightness (0.5-5)
model.terrainDarkness: number      // 0-1 (terrain darkening at night)
```

### Display Toggles

```typescript
model.blindOpen: boolean
model.showBuildings: boolean
model.showClouds: boolean
```

### Flight Speed

```typescript
model.flightSpeed: number  // Drift rate multiplier (0.1-5)
```

### Motion State (updated by tick())

```typescript
model.motionOffsetY: number    // Vibration + turbulence offset
model.bankAngle: number        // Degrees — horizon tilt from turn rate
model.breathingOffset: number  // Normalized — slow pitch oscillation
model.engineVibeX: number      // Pixels — high-freq engine hum X
model.engineVibeY: number      // Pixels — high-freq engine hum Y
```

### Weather Animation

```typescript
model.lightningIntensity: number  // 0-1 (storm lightning flashes)
```

### Transition State

```typescript
model.isTransitioning: boolean
model.transitionDestination: string | null
```

### Derived Properties

```typescript
model.localTimeOfDay: number                         // Viewer's local time (same as timeOfDay — circadian display)
model.skyState: SkyState                             // 'day' | 'night' | 'dawn' | 'dusk'
model.turbulenceLevel: 'light' | 'moderate' | 'severe'  // From WEATHER_EFFECTS lookup
model.showLightning: boolean                         // From WEATHER_EFFECTS lookup
model.effectiveCloudDensity: number                  // Adjusted for weather + time of day
model.currentLocation: Location                      // Resolved Location object
model.nightAltitudeTarget: number                    // Auto-altitude target for time of day
```

## Methods

### Location

```typescript
model.setLocation(locationId: LocationId): void
```

### Camera/Time

```typescript
model.setTime(hours: number): void      // 0-24
model.setAltitude(feet: number): void   // 10000-65000
model.setWeather(weather: WeatherType): void
model.setHeading(heading: number): void
model.setPitch(pitch: number): void
model.setCloudDensity(density: number): void
model.setTerrainDarkness(darkness: number): void
model.setLat(lat: number): void
model.setLon(lon: number): void
```

### Batch Update (Validated)

```typescript
model.applyPatch(patch: Partial<AeroWindowPatch>): void
// Single validated entry point for UI control updates.
// Routes each field through its setter with clamping/validation.
```

`AeroWindowPatch` fields: `altitude`, `timeOfDay`, `heading`, `pitch`, `weather`, `cloudDensity`, `terrainDarkness`, `cloudSpeed`, `cloudScale`, `haze`, `nightLightIntensity`, `flightSpeed`, `syncToRealTime`.

### Toggles

```typescript
model.toggleBlind(): void
model.toggleBuildings(): void
model.toggleClouds(): void
```

### User Interaction

```typescript
model.onUserInteraction(type: 'altitude' | 'time' | 'atmosphere'): void
// Pauses auto-behavior for 8 seconds during manual control
```

### Flight Transition

```typescript
model.flyTo(locationId: LocationId): Promise<void>
// Animated transition: blind close -> ascend -> cruise -> descend -> blind open
// Altitude animation is tick-driven (no separate RAF loop)
```

### Animation Tick

```typescript
model.tick(delta: number): void
// Called every frame - updates orbit, lightning, motion, altitude (including transitions)
```

### External Effect Helpers

```typescript
model.updateTimeFromSystem(): void
// Sets timeOfDay from browser clock. Called by $effect in +page.svelte.

model.getPersistedSnapshot(): PersistedState
// Returns current state for saving. Called by $effect in +page.svelte.
```

### Lifecycle

```typescript
model.destroy(): void
// Cleans up timeouts, aborts transitions, rejects pending altitude animations
```

## WEATHER_EFFECTS Lookup

Centralized weather configuration. Adding a new weather type requires only `weather-effects.ts` + `types.ts`.

```typescript
import { WEATHER_EFFECTS } from '$lib/core/weather-effects';

const fx = WEATHER_EFFECTS['storm'];
fx.turbulence       // 'severe'
fx.hasLightning     // true
fx.cloudDensityRange // [0.85, 1]
fx.nightCloudFloor  // 0.65
fx.rainOpacity      // 0.35
fx.windAngle        // 78
fx.filterBrightness // 0.9
fx.cloudColors.night // { near: '...', far: '...' }
```

## Types

### LocationId

```typescript
type LocationId =
  | 'dubai' | 'himalayas' | 'mumbai' | 'ocean'
  | 'desert' | 'clouds' | 'hyderabad' | 'dallas'
  | 'phoenix' | 'las_vegas';
```

### WeatherType

```typescript
type WeatherType = 'clear' | 'cloudy' | 'overcast' | 'storm';
```

### SkyState

```typescript
type SkyState = 'day' | 'night' | 'dawn' | 'dusk';
```

### Location

```typescript
interface Location {
  id: LocationId;
  name: string;
  lat: number;
  lon: number;
  utcOffset: number;
  hasBuildings: boolean;
  defaultAltitude: number;
  nightAltitude: number;
}
```

## Presentation Deriveds (Window.svelte)

These are **local** `$derived` values in `Window.svelte`, not part of the shared API:

- `skyBackground`: CSS gradient for sky
- `filterString`: CSS filter (brightness/contrast/saturate)
- `frostAmount`, `hazeOpacity`: Atmospheric effects
- `sunGlareX/Y/Opacity`: Sun position and intensity
- `lightPollutionOpacity`: Urban glow
- `turbulenceY/Rotate`, `breathingY`, `bankDegrees`: Motion offsets
- `motionTransform`: Combined CSS transform string
- `cabinReflectionOpacity`, `glassVignetteOpacity`: Glass effects

## Common Patterns

### Change Location

```typescript
model.setLocation('mumbai');
// or animated:
await model.flyTo('mumbai');
```

### Set Specific Time

```typescript
model.applyPatch({ syncToRealTime: false, timeOfDay: 18.5 }); // 6:30 PM
```

### Change Weather

```typescript
model.applyPatch({ weather: 'storm' });
// Turbulence, lightning, cloud density all auto-sync via WEATHER_EFFECTS + derived state
```

## Storage

State is automatically persisted to localStorage via `$effect` in `+page.svelte`:
- `location`, `altitude`, `weather`, `cloudDensity`
- `showBuildings`, `showClouds`, `syncToRealTime`

Key: `aero-window-v2`

## Reactivity

All state uses Svelte 5 runes:

```svelte
{#if model.skyState === 'night'}
  <NightEffects />
{/if}

<p>Altitude: {model.altitude.toFixed(0)} ft</p>
<p>Local Time: {model.localTimeOfDay.toFixed(1)}</p>
```
