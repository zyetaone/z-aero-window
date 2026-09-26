<script lang="ts">
	/**
	 * Clouds — PNG-sprite CLUSTER composition at the WGS84 cloud deck.
	 *
	 * TWO BANDS (counts are density-scaled — SSOT is clusterCountsForDensity
	 * in ../clouds/cluster-budget.ts; ranges below are dens=0..1):
	 *   - DISTANT: 8-95 large clusters at 42-307 km radius. 8-24 km
	 *              baseScale. 9-16 sprites/cluster. Horizon weather systems.
	 *   - CLOSE:   3-32 small clusters at 1.5-32 km radius. 1.5-4.5 km
	 *              baseScale. 4-10 sprites/cluster. Near clouds passing the
	 *              passenger window — sells the "flying THROUGH the deck" feel.
	 *
	 * Built imperatively (THREE.Sprite + per-sprite SpriteMaterial) so we
	 * can animate per-sprite material.rotation in useTask without a 100-
	 * way reactive prop binding. The driftGroup lives directly in the
	 * hybrid Canvas (camera provided by CameraMirror over Cesium).
	 *
	 * ─── CACHING STRATEGY ──────────────────────────────────────────────────
	 * Per-layer, top to bottom:
	 *
	 *   1. HTTP browser cache (the cloud webps in static/):
	 *      Served by Vite/the production node adapter with default headers.
	 *      For a kiosk Pi deployment we ship the bundle once + the webp
	 *      files never change → effectively cached forever after first load.
	 *      TODO if we ever go SaaS: add `Cache-Control: max-age=31536000,
	 *      immutable` on the webp routes.
	 *
	 *   2. Three.js Cache (in-memory after first decode):
	 *      `useTexture()` from @threlte/extras wraps THREE.TextureLoader
	 *      which uses Three.js's built-in Cache class — once decoded, the
	 *      Texture object is shared across all subscribers. We share three
	 *      textures across ~1,840 sprites → 3 GPU uploads, not 1,840.
	 *
	 *   3. Material per-sprite (NOT cached, intentional):
	 *      Each sprite owns its own SpriteMaterial so color/opacity can
	 *      diverge per frame in the modulator $effect. This is the
	 *      architectural bottleneck for sprite-batch draw calls (see the
	 *      `InstancedMesh` note below).
	 *
	 *   4. Pre-baked variants (build-time pipeline):
	 *      `scripts/process-clouds.ts` uses Bun.Image (1.3.14+) for
	 *      brightness pre-dim and optionally Sharp for Gaussian blur
	 *      variants (`cloud-soft.webp`). The runtime can swap TEXTURE_URLS
	 *      to load softer baked variants without paying any shader cost.
	 *
	 * ─── DEFERRED ARCHITECTURAL MOVES ──────────────────────────────────────
	 *   - InstancedMesh + billboarded plane shader: replace 1,840 individual
	 *     SpriteMaterial draws with a single instanced draw. Headroom to
	 *     push counts to 5,000+ without cost. ~3hr refactor. Blocking for
	 *     Pi 5 if we want the current visual + 60fps simultaneously.
	 *   - Custom ShaderMaterial fragment blur (5-tap Gaussian): real per-
	 *     fragment blur on cloud silhouettes. Currently faked via bloom
	 *     kernel VERY_LARGE on luminance > 0.38 peaks (real shader blur,
	 *     just luminance-gated). Worth doing if peaks alone aren't enough.
	 *   - Cloud shadow projection on ground: low-res depth-from-sun pass
	 *     stored as ground-shader uniform. Real soft shadows under cloud
	 *     clusters. Needs ground-shader hook on Cesium side.
	 * ─────────────────────────────────────────────────────────────────────
	 */
	import { T, useTask, useThrelte } from '@threlte/core';
	import { useTexture } from '@threlte/extras';
	import {
		Matrix4,
		Group,
		Sprite,
		SpriteMaterial,
		Color,
		Vector3,
		type Texture,
		type Group as ThreeGroup,
	} from 'three';
	import { LOCATION_MAP } from '$content/locations';
	import { CLOUD_DECK_M } from './state';
	import { sunElevationSin } from '$lib/world/sky';
	import { enuAnchorMatrix } from './enu';
	import { useAeroWindow } from '$lib/model/aero-window.svelte';
	import { createSeededRng, daySeed } from '$lib/world/prng';
	import { spriteOffset, spriteScale } from '$lib/world/clouds/sprite-placement';
	import { clusterCountsForDensity, drawCluster } from '../clouds/cluster-budget';
	import { lightingState } from '$lib/world/curves';

	let {
		density,
		nightFactor = 0,
		ambientColor,
		ambientIntensity = 1,
		sunDirection,
	}: {
		density: number;
		nightFactor?: number;
		ambientColor?: Color;
		ambientIntensity?: number;
		sunDirection?: [number, number, number];
	} = $props();

	const model = useAeroWindow();
	const ctx = useThrelte();
	const weather = $derived(model.weather);
	const location = $derived(model.location);
	const driftSpeed = $derived(model.config.atmosphere.clouds.speed);
	const opacityScale = $derived(model.config.atmosphere.clouds.opacityScale);

	// Scratch vectors for the per-frame Mie-scatter loop. Reused
	// each call so we don't allocate in the hot path.
	const _spriteWorld = new Vector3();
	const _viewVec = new Vector3();
	// Pre-computed once per frame: driftGroup's world-position origin.
	// Replaces per-sprite getWorldPosition() parent-chain walks (~1,840
	// matrix multiplications) with a single world-position read + per-
	// sprite applyMatrix4 (~1,840 vector × matrix multiplies, ~3× faster).
	const _driftWorldPos = new Vector3();

	const TEXTURE_URLS = ['/cloud.webp', '/cloud-dark.webp', '/cloud-smoke.webp'];
	const POOLS: Record<string, number[]> = {
		clear:    [0],
		cloudy:   [0],
		rain:     [0, 1],
		overcast: [1, 2],
		storm:    [1, 2],
	};

	const texturesPromise = useTexture(TEXTURE_URLS);
	// NOTE: an earlier turn here attempted a "mipmap LOD bias" trick via
	// anisotropy/generateMipmaps tweaks. That was wrong — those flags
	// don't bias mip-level selection in Three.js. Real LOD bias needs
	// either `texture2DLod()` in a custom shader OR a downscaled source
	// image. The bloom kernel (now VERY_LARGE, threshold 0.38) is doing
	// the actual fragment-level blur on cloud peaks; texture-side
	// softening is deferred until we move clouds to a custom shader.

	let anchorMatrix = $state.raw<Matrix4 | null>(null);
	let anchorGroup: ThreeGroup | undefined = $state.raw();

	const driftGroup = new Group();
	const rotSpeeds: number[] = [];
	// Per-cluster wind-shear factors stored at sprite granularity (so
	// each cluster's sprites share a single shear value picked at build
	// time). Range [-0.15, +0.15] modulates the wind drift on that sprite
	// — adjacent clusters end up drifting at slightly different effective
	// angles, breaking the lockstep "all clouds rotate together" feel.
	// Amplitude was ±0.4 originally; pulled back to ±0.15 because the
	// stronger value had clusters effectively swapping positions over
	// 30 minutes (2.33× rate ratio between fastest and slowest cluster).
	const shearFactors: number[] = [];
	const ownedMaterials: SpriteMaterial[] = [];

	function clearClusters(): void {
		while (driftGroup.children.length > 0) {
			driftGroup.remove(driftGroup.children[0]);
		}
		for (const m of ownedMaterials) m.dispose();
		ownedMaterials.length = 0;
		rotSpeeds.length = 0;
		shearFactors.length = 0;
	}

	function buildClusters(textures: Texture[], weatherKey: string, dens: number): void {
		clearClusters();
		const pool = POOLS[weatherKey] ?? POOLS.clear;

		// 3-Pi panorama determinism: seed with daySeed() so all three Pis
		// in a panorama generate IDENTICAL cluster positions on the same
		// day. Without this, Math.random gives each Pi its own RNG state
		// and the cloud seam between adjacent screens breaks. Same seed
		// is used across all rebuilds within a day (weather/density change
		// just changes counts + textures, not positions) — the day's
		// "cloud field" stays mentally consistent. Matches NightStars'
		// canonical pattern. See world/three/prng.ts for the full why.
		const rng = createSeededRng(daySeed());

		// Density scales counts (not a high floor + small dens offset). dens=0
		// is sparse; dens=1 keeps the prior storm budget (95 / 32). Seeded rng
		// is sequential — lower dens is a strict PREFIX of the same field
		// (3-Pi identical). See clusterCountsForDensity().
		// Pi lean (wing stays on): under qualityMode performance, cut sprite
		// count — daisy-chained fleet shares the tier via ambient peer-sync.
		const { distant: distantCount, close: closeCount } = clusterCountsForDensity(dens, {
			performance: model.config.world.qualityMode === 'performance',
		});

		for (let c = 0; c < distantCount; c++) {
			emitCluster(textures, pool, 42_000, 265_000, 8000, 16000, 9, 8, 0.03, rng);
		}
		for (let c = 0; c < closeCount; c++) {
			emitCluster(textures, pool, 1_500, 30_000, 1500, 3000, 4, 7, 0.10, rng);
		}
	}

	function emitCluster(
		textures: Texture[],
		pool: number[],
		radiusMin: number, radiusSpan: number,
		baseScaleMin: number, baseScaleSpan: number,
		spriteMin: number, spriteSpan: number,
		lonelyChance: number,
		rng: () => number,
	): void {
		// ⚠ LOAD-BEARING INVARIANT (3-Pi seam): emitCluster must consume the
		// same rng draws for every cluster regardless of density or cluster
		// index — density only changes how MANY times buildClusters calls
		// this, so a lower density is a strict PREFIX of the same seeded
		// field. The header draws come from the shared pure helper so the
		// sequence is pinned count-independent (see drawCluster in
		// ../clouds/cluster-budget.ts and its prefix test). Do NOT let density
		// or the cluster index leak into ANY draw here — including the
		// per-sprite loop below — or adjacent screens diverge.
		const { cx, cz, ch, baseScale, spriteCount, shear: clusterShear } =
			drawCluster(radiusMin, radiusSpan, baseScaleMin, baseScaleSpan, spriteMin, spriteSpan, lonelyChance, rng);

		for (let i = 0; i < spriteCount; i++) {
			// Within-cluster X/Z spread: 1.85× (pulled back from the over-
			// aggressive 2.20 — that doubled overdraw without proportional
			// visual gain). 1.85 is still meaningfully wider than the
			// original 1.40 and balances spread vs fillrate cost.
			// Anchor sprite (i=0) is PLACED AT CLUSTER CENTER (not randomly
			// offset like the others) — fixes a long-standing misnaming.
			// Now the cluster has a guaranteed bright core; the surrounding
			// sprites fill outward from it for true accumulation geometry.
			const { ox, oy, oz } = spriteOffset(i, cx, ch, cz, baseScale, rng);

			const idx = pool[Math.floor(rng() * pool.length)];
			// Per-sprite scale: [0.95, 1.45]× for non-anchors, anchor at
			// 1.25× (pulled from 1.35× — less individual dominance, more
			// even soft mass).
			const sprScale = spriteScale(i, baseScale, rng);
			const sprX = sprScale * 1.30;
			const sprY = sprScale;

			// Shadow gradient softened drastically. Was: 0.55 + yNorm × 0.32
			// (range 0.55–0.87, ~32% top/bottom contrast — read as a drawn
			// underside). Now: smoothstep(yNorm) × 0.12 + 0.62 (range
			// 0.62–0.74, ~12% contrast with smoothstep easing). The "hard
			// underside line" effect is gone; clusters read as homogeneous
			// soft mass.
			const yRaw = (oy - ch + baseScale * 0.09) / (baseScale * 0.18);
			const yClamp = Math.max(0, Math.min(1, yRaw));
			const ySoft = yClamp * yClamp * (3 - 2 * yClamp);
			const brightness = 0.62 + ySoft * 0.12;

			// Base opacity raised [0.18, 0.42] → [0.24, 0.52] → [0.30, 0.60]:
			// the denser sprite field reads thin on the Pi wall. Accumulation
			// still carries total thickness; individual puffs keep a soft gradient.
			const baseOpacity = 0.3 + rng() * 0.3;

			const mat = new SpriteMaterial({
				map: textures[idx],
				transparent: true,
				opacity: baseOpacity,
				depthWrite: false,
				color: new Color(brightness, brightness, brightness),
				rotation: rng() * Math.PI * 2,
			});
			mat.userData.baseBrightness = brightness;
			mat.userData.baseOpacity = baseOpacity;
			// Within-cluster offset vector normalized — used as a pseudo-
			// surface normal for sun-side shading at runtime. Sprites on
			// the sun-facing side of the cluster brighten; sprites on the
			// shadow side stay neutral. This adds within-cluster 3D shading
			// the yNorm gradient alone can't deliver — clusters now have
			// a sun-facing bright face and a shadow-side dim face.
			const dx = ox - cx;
			const dy = oy - ch;
			const dz = oz - cz;
			const mag = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
			mat.userData.offsetNX = dx / mag;
			mat.userData.offsetNY = dy / mag;
			mat.userData.offsetNZ = dz / mag;
			ownedMaterials.push(mat);

			const sprite = new Sprite(mat);
			sprite.position.set(ox, oy, oz);
			sprite.scale.set(sprX, sprY, 1);
			driftGroup.add(sprite);

			rotSpeeds.push((rng() - 0.5) * 0.08);
			shearFactors.push(clusterShear);
		}
	}

	// ENU basis at the city's lat/lon, at cloud-deck altitude.
	$effect(() => {
		const loc = LOCATION_MAP.get(location);
		if (!loc) { anchorMatrix = null; return; }
		anchorMatrix = enuAnchorMatrix(loc.lat, loc.lon, CLOUD_DECK_M);
	});

	$effect(() => {
		if (!anchorGroup || !anchorMatrix) return;
		anchorGroup.matrixAutoUpdate = false;
		anchorGroup.matrix.copy(anchorMatrix);
	});

	// Debounced rebuild: buildClusters() allocates ~1,840 SpriteMaterial
	// objects and disposes the old ones — ~30-50 ms blocking on the main
	// thread. Without debounce, an admin slider for cloud density triggers
	// a rebuild on every value change (potentially 60×/sec while dragging)
	// causing visible frame stutters. 200 ms debounce coalesces rapid
	// changes — the user sees the new clouds ~200 ms after they stop
	// adjusting the slider, which feels responsive without the stutter.
	//
	// Deliberately NOT keyed on anchorMatrix: the seeded field is
	// location-independent (same daySeed(), ENU-local coords), so a flyTo
	// arrival only needs the matrix-copy effect above to re-anchor the
	// existing clusters — rebuilding here would cost a 30-50 ms hitch on
	// every location change for an identical field.
	const REBUILD_DEBOUNCE_MS = 200;
	let _rebuildTimeout: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		const w = weather;
		const d = density;
		let cancelled = false;
		if (_rebuildTimeout !== null) clearTimeout(_rebuildTimeout);
		_rebuildTimeout = setTimeout(() => {
			_rebuildTimeout = null;
			if (cancelled) return;
			texturesPromise.then((textures) => {
				if (cancelled) return;
				buildClusters(textures, w, d);
			});
		}, REBUILD_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			if (_rebuildTimeout !== null) {
				clearTimeout(_rebuildTimeout);
				_rebuildTimeout = null;
			}
		};
	});

	// Cheap runtime modulation — no full rebuild.
	// useTask instead of $effect: during flight, all deps (nightFactor,
	// ambientColor, sunDirection, camera position) change every frame.
	// $effect can fire multiple times per reactive flush when deps resolve
	// at staggered times; useTask guarantees exactly one execution per
	// render frame, avoiding the ~2.5µs Svelte dep-tracking overhead.
	// useTask runs outside Svelte tracking (renderer.setAnimationLoop) —
	// no untrack() needed (same contract as Wing.svelte).
	useTask(() => {
			// Skip all per-sprite work while the cloud group is unmounted
			// (showClouds off / no anchor): useTask fires regardless of the
			// {#if} below, so without this ~1840 sprites were re-lit and
			// re-drifted every frame for an invisible group.
			if (!model.config.world.showClouds || !driftGroup.parent) return;
			const nf = nightFactor;
			// Unified lighting SSOT — the cloud darkening / city-glow / moon-lift now
			// read the same gates as every other Three layer (cityGlowAmount lights up
			// at dusk in lock-step with the city-light bloom; moonContribution gates the grey
			// moon-lift by actual moon presence instead of raw nf).
			// Real local solar elevation — drives lightingState's ambient horizon
			// boost AND liveSunBoost below. (Previously sunDirection was passed and
			// its constant [1] component froze the horizon response mid-state.)
			const elevSin = sunElevationSin(model.flight.camLat, model.timeOfDay);
			const L = lightingState(model.timeOfDay, model.nightFactor, elevSin);
			const ambR = ambientColor?.r ?? 1;
			const ambG = ambientColor?.g ?? 1;
			const ambB = ambientColor?.b ?? 1;
			const ambI = ambientIntensity;
			const opaScale = opacityScale;
	
			// nightDark multiplier: 0.55 read MILKY/daylit at deep night (the
			// lit term held 45% brightness which, summed with the moonLit floor
			// + bloom, blew clouds to bright grey-white). Pulled to 0.78 so the
			// daylit lit-term collapses to ~22% at nf=1 — clouds read as DIM
			// grey-blue masses, not white. The moonLit floor below (also dropped)
			// supplies the only night visibility, keeping them as silhouetted
			// moonlit deck rather than a black void. Dawn/dusk (nf<1) ramps in
			// proportionally so day/golden-hour are unchanged. The cool channel
			// shifts are deepened (coolG/coolB) to push the residual toward the
			// blue-grey of a moonlit night sky instead of neutral grey.
			const nightDark = 1 - nf * 0.78;
			const coolG = 1 - nf * 0.22;
			const coolB = 1 - nf * 0.08;
	
			// City skyglow factor — when over a city archetype at night, light
			// pollution from the urban core below reflects off cloud bases as a
			// warm-amber wash. Combined with cluster density (more clouds = more
			// reflective surface), this gives the unmistakable "Las Vegas glow"
			// or "Dubai amber clouds" effect. Hyderabad too. hasBuildings is the
			// SSOT for "urban illuminated archetype." Gated by nf so day is
			// unaffected. Outdoor / desert / ocean / himalaya locations stay
			// neutral grey.
			const loc = LOCATION_MAP.get(model.location);
			const cityFactor = loc?.hasBuildings ? 1 : 0;
			// 0.22: tuned so peak amber additive on R is ~0.15 of baseB at
			// dense-cloud full-night over a city. Combined with the EffectStack
			// VERY_LARGE bloom kernel, this reads as a recognizable warm wash
			// without driving the underside to saturation white. Increase to
			// 0.35 for "Las Vegas dramatic" effect, lower for subtler glow.
			const cityGlowStrength = L.cityGlowAmount * cityFactor * density * 0.22;
	
			// Overall sun-lit brightness lift — scales with the REAL local solar
			// elevation (high sun = brighter deck, horizon sun = dimmer). The old
			// version dotted sunDirection with an up-ish pseudo-normal, but
			// sunDirection's y is the CONSTANT polar-axis projection — the boost
			// was frozen at one mid-state value all day. (sunDirection itself is
			// still used below for the AZIMUTHAL terms — Mie forward-scatter and
			// sun-side cluster shading — where the world direction is meaningful.)
			const sd = sunDirection;
			const liveSunBoost = Math.max(0, elevSin) * (1 - nf) * 0.52;
	
			// Per-sprite Mie forward-scatter — clouds whose direction-from-camera
			// closely aligns with the sun direction get a sharp warm glow boost.
			// This is the "golden hour cloud" / "sun-shining-through-cloud" effect.
			// pow(dot, 6) makes the peak sharp so only clouds NEAR the sun bloom;
			// clouds away from the sun stay neutral. Gated by (1-nf) so it's
			// inactive at night.
			const sun = sd && sd.length === 3 ? sd : null;
			const camPos = ctx.camera.current.position;
			const mieGain = sun ? (1 - nf) * 0.85 : 0;
			const children = driftGroup.children;
			const n = ownedMaterials.length;
	
			// Compute drift-group world origin once — all sprites share the same
			// ancestor chain (sprite → driftGroup → anchorGroup → scene). Using
			// applyMatrix4(driftGroup.matrixWorld) is ~3× faster than per-sprite
			// getWorldPosition() which walks the parent chain for each sprite.
			// updateWorldMatrix(parents=true, children=false): we only need driftGroup's
			// OWN matrixWorld current for getWorldPosition — the old updateMatrixWorld()
			// recursed into all ~1840 sprite descendants every frame for nothing.
			driftGroup.updateWorldMatrix(true, false);
			driftGroup.getWorldPosition(_driftWorldPos);
	
			for (let i = 0; i < n; i++) {
				const mat = ownedMaterials[i];
				const sprite = children[i];
				const baseB = (mat.userData.baseBrightness ?? 1) as number;
				const baseO = (mat.userData.baseOpacity ?? 1) as number;
	
				let mie = 0;
				let sunSide = 0;
				if (sun && sprite) {
					_spriteWorld.copy(sprite.position).applyMatrix4(driftGroup.matrixWorld);
					_viewVec.subVectors(_spriteWorld, camPos).normalize();
					const dot = Math.max(0, _viewVec.x * sun[0] + _viewVec.y * sun[1] + _viewVec.z * sun[2]);
					// Sharp peak when sun is directly behind cloud from cam POV.
					// dot^6 via repeated multiply — V8 inlines integer-power mul
					// roughly 4× faster than Math.pow on Pi 5's V8 build. The
					// inner loop runs 1840×/frame so this is non-trivial.
					const d2 = dot * dot;
					const d4 = d2 * d2;
					const fwd = d4 * d2;
					mie = fwd * mieGain;
	
					// Within-cluster sun-side shading. The sprite's offset from
					// cluster center (stored as a normalized pseudo-normal at
					// build time) dotted with the sun direction tells us
					// whether this sprite is on the sun face (positive dot) or
					// the shadow face (negative dot). Sun-face sprites get a
					// brightness boost; shadow-face stay neutral. Smoothstep'd
					// soft terminator (-0.2..0.6 dot range) avoids hard mid-
					// cluster contrast. Gated by (1-nf) so night clusters
					// don't get directional shading from a non-visible sun.
					const nx = (mat.userData.offsetNX ?? 0) as number;
					const ny = (mat.userData.offsetNY ?? 0) as number;
					const nz = (mat.userData.offsetNZ ?? 0) as number;
					const sunDot = nx * sun[0] + ny * sun[1] + nz * sun[2];
					const t = Math.max(0, Math.min(1, (sunDot + 0.2) / 0.8));
					sunSide = t * t * (3 - 2 * t) * (1 - nf) * 0.30;
				}
	
				// Per-channel warm shift on the Mie boost: warm-amber tint
				// (R strongest, G mid, B suppressed) so golden-hour clouds
				// read warm instead of just brighter. sunSide adds a near-
				// neutral white-warm directional brighten (R≈G≈B with slight
				// blue suppression) — gives clusters a sun-lit hemisphere.
				const litR = baseB * (1 + liveSunBoost * 0.85 + mie * 1.40 + sunSide * 1.05);
				const litG = baseB * (1 + liveSunBoost * 0.85 + mie * 0.95 + sunSide * 1.00);
				const litB = baseB * (1 + liveSunBoost * 0.85 + mie * 0.42 + sunSide * 0.85);
	
				// Moonlit floor — additive grey-blue lift gated by nightFactor.
				// Without this, the ambient pipeline crushes clouds to ~1-2% per
				// channel — black silhouettes. But the prior 0.16 coefficient
				// over-lifted: combined with the (then higher) nightDark floor +
				// bloom it read as milky white. Dropped 0.16 → 0.085 so the deck
				// stays DIM — visible as grey-blue mass, not a bright wash. The
				// blue bias is carried in the per-channel mix below (B > R) so it
				// reads as cool moonlight Rayleigh scatter, not neutral white.
				const moonLit = L.moonContribution * baseB * 0.085;
	
				// City skyglow — warm-amber additive on cluster underside.
				// Strong on R, mid on G, weak on B → reads as sodium-amber
				// light pollution. Scaled by per-sprite baseB so denser cluster
				// cores glow stronger than wispy edges. cityGlowStrength is
				// already gated by nf + cityFactor + density so this is a clean
				// linear contribution: at full night over Hyderabad with 80%
				// cloud density, the underside picks up ~24% warm bias.
				const cityLitR = cityGlowStrength * baseB * 1.00;
				const cityLitG = cityGlowStrength * baseB * 0.55;
				const cityLitB = cityGlowStrength * baseB * 0.18;
	
				// Moonlit per-channel mix biased COOL (R suppressed, B lifted) so
				// the dim night deck reads grey-blue like real moonlit cumulus,
				// not neutral/warm grey. R 0.82 < G 1.0 < B 1.22.
				mat.color.setRGB(
					litR * nightDark         * ambR * ambI + moonLit * 0.82 + cityLitR,
					litG * nightDark * coolG * ambG * ambI + moonLit * 1.00 + cityLitG,
					litB * nightDark * coolB * ambB * ambI + moonLit * 1.22 + cityLitB,
				);
				mat.opacity = baseO * opaScale;
			}
	});

	// Per-frame: rotate each sprite + wind-drift around city vertical.
	// Reading anchorMatrix here makes it a live tick-path dependency so
	// the autofixer cannot dead-code-eliminate the anchor scaffolding.
	//
	// Wind gusts: two slow, mutually irrational sinusoids multiplied
	// together produce a quasi-random envelope in [0.45, 1.55] that
	// modulates both the per-sprite spin and the cluster drift. The
	// irrational ratios (0.137, 0.273) prevent the gusts from cycling
	// — passenger never sees the same gust pattern twice in a window.
	let _windT = 0;
	useTask((dt) => {
		void anchorMatrix;
		if (!model.config.world.showClouds || !driftGroup.parent) return;
		_windT += dt;
		const gust = 1 + 0.55 * Math.sin(_windT * 0.137) * Math.cos(_windT * 0.273);
		// Slow wind-speed modulation. Range [0.6, 1.6] — ALWAYS positive
		// so clouds never freeze. The variance gives wind that ebbs and
		// surges over ~6 min but doesn't reverse direction. Reversal looked
		// broken in practice (drift went to net-zero for long stretches);
		// real wind ebbs and flows but doesn't flip 180° within minutes.
		// Also bumped 0.004 → 0.007 so drift is genuinely visible at the
		// default 0.4 driftSpeed — previous coefficient gave ~0.09 °/sec
		// which is below the noticeability threshold.
		const windMag = 1.1 + 0.5 * Math.sin(_windT * 0.017) * Math.cos(_windT * 0.041);
		const driftDelta = dt * driftSpeed * 0.007 * gust * windMag;
		const children = driftGroup.children;
		for (let i = 0; i < children.length; i++) {
			const s = children[i] as Sprite;
			// Per-sprite spin × gust modulation.
			s.material.rotation += rotSpeeds[i] * dt * gust;
			// Per-cluster wind shear: each sprite's local position rotates
			// around driftGroup origin at an angle modified by its cluster's
			// shear factor. Clusters with positive shear drift faster than
			// the base; negative-shear clusters drift slower / counter to
			// the gust. Adjacent clusters NEVER drift in perfect lockstep.
			const shear = shearFactors[i] ?? 0;
			const localDelta = driftDelta * shear;
			if (localDelta !== 0) {
				const c = Math.cos(localDelta);
				const sn = Math.sin(localDelta);
				const px = s.position.x;
				const pz = s.position.z;
				s.position.x = px * c - pz * sn;
				s.position.z = px * sn + pz * c;
			}
		}
		// Base drift on the whole group — the shared wind direction.
		driftGroup.rotation.y += driftDelta;
	});

	$effect(() => () => clearClusters());
</script>

{#if anchorMatrix && model.config.world.showClouds}
	<T.Group bind:ref={anchorGroup}>
		<T is={driftGroup} />
	</T.Group>
{/if}
