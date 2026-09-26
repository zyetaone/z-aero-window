<script lang="ts">
	/**
	 * Clouds — High-Fidelity Photoreal 3D Atmospheric Cloud Deck.
	 *
	 * Ported from canonical Aero cluster-accumulation architecture:
	 * - Dual-tier cluster budget:
	 *   - DISTANT: 40 km - 260 km horizon weather systems with high albedo.
	 *   - CLOSE: 2 km - 35 km volumetric cumulus passing the passenger window.
	 * - Anchor-centered multi-sprite accumulation geometry with soft radial falloff.
	 * - True 3D sun-normal shading & Mie forward-scatter (pow(dot, 6) solar halo).
	 * - Circadian lighting: golden-hour amber Mie scatter, cool-blue moonlight floor,
	 *   and city sodium underglow.
	 * - Differential wind-shear & multi-frequency gust dynamics.
	 * - 100% deterministic 3-Pi panorama alignment via seeded RNG.
	 */
	import { useDisplay } from '../display.svelte.js';
	/**
	 * Named imports, not `import * as THREE`.
	 *
	 * MEASURED to be style, not size: the kiosk chunk is 423KB gz either way,
	 * because three ships proper ESM and Rollup already treeshakes through the
	 * namespace object — and what survives (SkinnedMesh, InstancedMesh, ...)
	 * is retained by GLTFLoader, which must be able to load any glTF content.
	 * Kept because an explicit list is the honest statement of what this file
	 * uses, and because the next reader should not have to re-run that
	 * measurement to know the namespace was not the problem.
	 */
	import {
		AmbientLight,
		Color,
		Group,
		PerspectiveCamera,
		SRGBColorSpace,
		Scene,
		Sprite,
		SpriteMaterial,
		Texture,
		TextureLoader,
		Vector3,
		WebGLRenderer
	} from 'three';
	import { mulberry32, slotNoise, windDriftAngle } from '../flight/flight-path.js';
	import { weatherLightLoss } from './atmosphere.js';
	// Field math (counts, pools, brightness, draw order) lives in
	// cloud-field.ts — the tested merge of this deck's design with aero-1's
	// pinned-contracts. This file maps descriptors onto Three.js objects.
	import {
		buildCloudField,
		CLOUD_BRIGHTNESS,
		CLOUD_POOLS,
		CLOUD_PROXIMITY,
		CIRRUS_POOLS,
		cirrusCountFor,
		distantCountFor,
		nearCountFor,
		WEATHER_COVERAGE
	} from './cloud-field.js';

	const display = useDisplay();

	const isVisible = $derived(display.config.clouds);
	const density = $derived(display.config.cloudDensity);
	const driftSpeed = $derived(display.config.cloudSpeed);
	const cloudAltM = $derived(display.config.cloudAltitudeM);
	const opacityScale = $derived(display.config.cloudOpacity);

	/**
	 * Weather darkens the deck's own bases.
	 *
	 * Read inside the render loop (untracked there, like every other knob), so
	 * changing the weather does not rebuild the sprite population — only how it
	 * is lit. A storm cloud is not a fair-weather cumulus with more of it; it
	 * is the same shape with a much darker base.
	 */
	const overcast = $derived(weatherLightLoss(display.config.weather));

	/**
	 * How much sky the weather actually fills.
	 *
	 * The deck was the SAME SIZE in every weather — measured, all five: 439
	 * sprites on `clear`, 439 on `storm`. Weather changed how the deck was LIT
	 * and never how much of it there was, so a clear day carried a full storm's
	 * worth of cloud and a storm added nothing but darkness. That is the wrong
	 * half of the phenomenon: an overcast sky is not a sunny sky turned down, it
	 * is a sky with more cloud in it.
	 *
	 * The comment above is still right about the base darkening — a storm cloud
	 * is a cumulus with a much darker base, not a paler one repeated. Both are
	 * true, and only one was implemented.
	 *
	 * Multiplies the count rather than replacing `cloudDensity`, so the operator
	 * slider keeps meaning "how cloudy is this scene" and weather scales around
	 * whatever they chose. Table lives in cloud-field.ts (tested there).
	 *
	 * Rebuild cost is the reason this is a coarse multiplier and not a live
	 * knob: it joins `density` in the rebuild effect, so a weather change
	 * re-rolls the deck ONCE. Reading it per frame would rebuild 400+ sprites
	 * every frame.
	 *
	 * The sky breathes on a 15-minute slot: coverage drifts ±20% around the
	 * weather base, so a clear day slowly gathers and sheds its scattered
	 * layer instead of holding one frozen deck all afternoon. Quantized to
	 * the slot (not the frame) so the rebuild effect below fires at most
	 * four times an hour, and `slotNoise` is wall-shared — every pane
	 * re-rolls the same deck for the same quarter hour.
	 */
	const coverSlot = $derived(Math.floor(display.view.wallSec / 900));
	const coverageScale = $derived(
		(WEATHER_COVERAGE[display.config.weather] ?? 1) * (0.8 + 0.4 * slotNoise(coverSlot, 11))
	);

	/**
	 * The deck is the biggest GPU cost in the window, and it was the one thing
	 * the thermal shed did not touch.
	 *
	 * `Display.svelte` drops `qualityMode` to `performance` when the Pi reports
	 * live throttling, and until now only RainGlass read it — so a device
	 * cooking at 82 C shed fourteen rain droplets and kept every one of ~300
	 * cloud sprites. Halving the deck is the shed that actually buys frames.
	 *
	 * Read here rather than in `buildCloudDeck` so it joins `density` in the
	 * rebuild effect: a thermal event rebuilds the deck once, it does not
	 * re-light it per frame.
	 */
	const qualityScale = $derived(display.config.qualityMode === 'performance' ? 0.5 : 1);

	const TEXTURE_URLS = ['/cloud.webp', '/cloud-dark.webp', '/cloud-smoke.webp'];

	// Scratch math vectors
	const _spriteWorld = new Vector3();
	const _viewVec = new Vector3();
	const _sunDir = new Vector3();

	/**
	 * The deck's whole life, attached to the canvas that owns it. Same shape as
	 * `Wing.svelte`, and argument-free for the same reason: `{@attach f(x)}`
	 * re-runs on any change to `x`, and this one loads textures and emits
	 * hundreds of sprites.
	 */
	function cloudScene(c: HTMLCanvasElement) {
		const renderer = new WebGLRenderer({
			canvas: c,
			alpha: true,
			antialias: true,
			powerPreference: 'high-performance'
		});
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.setSize(c.clientWidth, c.clientHeight, false);

		const scene = new Scene();
		const camera = new PerspectiveCamera(50, c.clientWidth / c.clientHeight, 10, 900_000);
		camera.position.set(0, 0, 0);

		const ambient = new AmbientLight(0xffffff, 0.9);
		scene.add(ambient);

		const cloudGroup = new Group();
		scene.add(cloudGroup);

		const textureLoader = new TextureLoader();
		const textures: Texture[] = [];
		let settled = 0;

		/** Build once every load has finished, with whatever survived. */
		function done() {
			if (++settled < TEXTURE_URLS.length) return;
			const loaded = textures.filter(Boolean);
			if (loaded.length === 0) {
				console.warn('[Clouds] No cloud textures loaded — the deck stays empty.');
				return;
			}
			textures.length = 0;
			textures.push(...loaded);
			buildCloudDeck();
			/**
			 * `$state`, so publishing the hook re-runs the effect below.
			 *
			 * The textures load asynchronously, so this assignment happens AFTER
			 * the effect's first run — with a plain `let` the effect would have
			 * captured `null`, and nothing would re-run it until the operator
			 * next moved the slider. That is a real window, not a theoretical
			 * one: a density set by URL, or by a preset applied during texture
			 * load, would be silently ignored until the next unrelated change.
			 */
			rebuild = buildCloudDeck;
			/**
			 * Sprite count, for `tools/probe-layers.mjs`.
			 *
			 * The same escape hatch `Stage.svelte` opens with `__stage`, and for
			 * the same reason: the property this publishes cannot be observed
			 * from outside the WebGL context, and the bug it guards (a knob that
			 * silently stops reaching its consumer) is invisible to every check
			 * that does not measure the scene itself.
			 */
			(globalThis as unknown as { __cloudSprites?: () => number }).__cloudSprites = () =>
				sprites.length;
			(globalThis as unknown as { __probe?: () => number }).__probe = () => sprites.length;
		}

		TEXTURE_URLS.forEach((url, i) => {
			textureLoader.load(
				url,
				(tex) => {
					tex.colorSpace = SRGBColorSpace;
					textures[i] = tex;
					done();
				},
				undefined,
				(err) => {
					// Counted, not just logged. The build fired on `loadedCount ===
					// TEXTURE_URLS.length` and only successes incremented it, so a
					// single 404 among the three meant NO cloud deck at all, for
					// the life of the process, announced by one console.warn.
					console.warn('[Clouds] Texture load failed:', err);
					done();
				}
			);
		});

		const sprites: Sprite[] = [];
		const materials: SpriteMaterial[] = [];
		const rotSpeeds: number[] = [];
		const shearFactors: number[] = [];
		/**
		 * Where each sprite starts, so the loop can SET its pose from the wall
		 * clock instead of nudging it every frame. See `gustPhase` below.
		 */
		const baseRot: number[] = [];
		const basePos: number[] = [];

		function buildCloudDeck() {
			while (cloudGroup.children.length > 0) {
				cloudGroup.remove(cloudGroup.children[0]);
			}
			materials.forEach((m) => m.dispose());
			materials.length = 0;
			sprites.length = 0;
			rotSpeeds.length = 0;
			shearFactors.length = 0;
			baseRot.length = 0;
			basePos.length = 0;

			if (textures.length === 0) return;

			// Seeded RNG from daySeed for 3-Pi multi-screen determinism
			const seed = Math.floor(display.phase * 1_000_003) + 1;
			const rng = mulberry32(seed);

			// Weather-dealt texture pools: composition (which texture each slot
			// means) is the single-sourced CLOUD_POOLS table in cloud-field.ts;
			// here each index resolves to its loaded Texture object.
			const wkey = display.config.weather;
			const white = textures[0];
			const dark = textures[1] ?? textures[0];
			const smoke = textures[2] ?? textures[0];
			const triple = [white, dark, smoke];
			const pool = (CLOUD_POOLS[wkey] ?? CLOUD_POOLS.clear).map((i) => triple[i]);
			const cirrusObjects = (CIRRUS_POOLS[wkey] ?? CIRRUS_POOLS.clear).map((i) => triple[i]);
			const brightBase = CLOUD_BRIGHTNESS[wkey] ?? 0.8;
			// Near weather closes in physically too, not just optically.
			const prox = CLOUD_PROXIMITY[wkey] ?? 0;
			const nearRadius = 1 - 0.45 * prox;

			// The population itself is built by cloud-field.ts on the shared
			// stream (distant, then near, then cirrus) — this function only maps
			// descriptors onto Three.js objects. Counts, pools, brightness and
			// draw order are tested there; nothing here may consume `rng`.
			const field = buildCloudField({
				rand: rng,
				weather: (CLOUD_POOLS[wkey] ? wkey : 'clear') as keyof typeof CLOUD_POOLS,
				brightBase,
				nearRadius,
				distantCount: distantCountFor(density, qualityScale, coverageScale),
				nearCount: nearCountFor(density, qualityScale, coverageScale),
				cirrusCount: cirrusCountFor(density, qualityScale, coverageScale)
			});

			for (const cluster of field) {
				const texList = cluster.tier === 2 ? cirrusObjects : pool;
				for (const s of cluster.sprites) {
					const tex = texList[s.texSlot] ?? texList[0];
					const mat = new SpriteMaterial({
						map: tex,
						transparent: true,
						opacity: s.opacity * opacityScale,
						depthWrite: false,
						color: new Color(s.brightness, s.brightness, s.brightness),
						rotation: s.rotation
					});

					// Pseudo-normal for sun-side 3D shading, from the cluster
					// centre the descriptor carries.
					const dx = s.ox - cluster.cx;
					const dy = s.oy - cluster.ch;
					const dz = s.oz - cluster.cz;
					const mag = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;

					mat.userData = {
						baseBrightness: s.brightness,
						baseOpacity: s.opacity,
						normX: dx / mag,
						normY: dy / mag,
						normZ: dz / mag
					};
					materials.push(mat);

					const sprite = new Sprite(mat);
					sprite.position.set(s.ox, s.oy, s.oz);
					sprite.scale.set(s.sprScale, s.sprScale, 1);

					cloudGroup.add(sprite);
					sprites.push(sprite);
					rotSpeeds.push(s.rotSpeed);
					shearFactors.push(cluster.shear);
					baseRot.push(s.rotation);
					basePos.push(s.ox, s.oz);
				}
			}
		}

		let raf: number;

		const renderLoop = () => {
			if (
				c.clientWidth !== renderer.domElement.width ||
				c.clientHeight !== renderer.domElement.height
			) {
				const w = c.clientWidth;
				const h = c.clientHeight;
				if (w > 0 && h > 0) {
					renderer.setSize(w, h, false);
					camera.aspect = w / h;
					camera.updateProjectionMatrix();
				}
			}

			// Synchronize relative camera altitude, pitch and banking tilt.
			// The deck climbs toward the aircraft with the weather
			// (CLOUD_PROXIMITY): read per frame so it glides, no rebuild.
			const planeAgl = display.view.aglM;
			const proxNow = CLOUD_PROXIMITY[display.config.weather] ?? 0;
			// Slow altitude wander (±250 m over ~10 min, wall-shared phase):
			// the deck lifts and settles instead of sitting on its knob value
			// all day. Per-frame read, so it glides — never a rebuild.
			const effAltM =
				cloudAltM +
				(planeAgl - cloudAltM) * proxNow +
				Math.sin(display.view.wallSec / 600 + display.phase) * 250;
			const deltaAltM = planeAgl - effAltM;
			camera.position.set(
				0,
				Math.abs(deltaAltM) < 150 ? Math.sign(deltaAltM || 1) * 150 : deltaAltM,
				0
			);

			const pitchDeg = display.config.pitchDeg ?? -10;
			const bankDeg = display.view.bankDeg;
			const effectivePitchRad = ((pitchDeg + bankDeg * 0.12) * Math.PI) / 180;
			const bankRad = (bankDeg * Math.PI) / 180;

			camera.rotation.order = 'YXZ';
			camera.rotation.x = effectivePitchRad;
			camera.rotation.y = 0;
			camera.rotation.z = -bankRad;

			// World-locked compass orientation + continuous wind drift & gust modulation
			const bearingRad = (display.view.cameraBearingDeg * Math.PI) / 180;
			const wallSec = display.view.wallSec;

			/**
			 * Gusting wind, as a POSITION on the clock rather than a speed to
			 * accumulate.
			 *
			 * The deck used to integrate: `windT += dt` off `performance.now()`,
			 * a gust factor computed from `windT`, and then `+=` again onto every
			 * sprite's spin and position. Three per-pane accumulators, in a deck
			 * whose own docstring claims 3-Pi determinism. Each pane dropped
			 * frames its own way and `Math.min(0.1, dt)` discarded the overflow,
			 * so the wind phase drifted apart with uptime -- the same shape that
			 * split the director before it moved to a wall-clock slot, and a
			 * blocker on the wall in v1. Panes agree at a glance and disagree
			 * after an hour.
			 *
			 * This is the same gust, expressed as an absolute phase: it advances
			 * at roughly 1 per second and breathes about that, so `d/dt` looks
			 * like the old `gust` factor without anything being remembered
			 * between frames. Every pane computes the same value for the same
			 * second, and a pane that reboots rejoins the weather mid-gust.
			 */
			const gustPhase = wallSec + 3.6 * Math.sin(wallSec * 0.137) * Math.cos(wallSec * 0.273);
			const driftPhase = gustPhase * driftSpeed * 0.008;
			// Direction-signed: the wind follows the circuit, so a reversed
			// loop reverses the drift instead of flying backwards through it.
			cloudGroup.rotation.y =
				bearingRad + windDriftAngle(wallSec, driftSpeed, display.config.direction ?? 1);

			// ── Per-Sprite 3D Solar Lighting & Mie Forward-Scatter ─────────────────
			const sunElev = display.sun.elevationDeg;
			const sunAzimuth = display.sun.azimuthDeg;
			const night = display.night;
			const dayFactor = Math.max(0, 1 - night);

			// Spherical sun direction vector in Three.js coordinates
			const sunElevRad = (sunElev * Math.PI) / 180;
			const sunAzRad = (sunAzimuth * Math.PI) / 180;
			_sunDir
				.set(
					Math.sin(sunAzRad) * Math.cos(sunElevRad),
					Math.sin(sunElevRad),
					-Math.cos(sunAzRad) * Math.cos(sunElevRad)
				)
				.normalize();

			// No sun disc through an overcast, so no forward-scatter halo either.
			const mieGain = dayFactor * (sunElev > 0 && sunElev < 25 ? 1.4 : 0.6) * (1 - overcast);
			const liveSunBoost = Math.max(0, Math.sin(sunElevRad)) * dayFactor * 0.6;
			const nightDark = (1 - night * 0.78) * (1 - overcast * 0.45);
			const coolG = 1 - night * 0.22;
			const coolB = 1 - night * 0.08;
			const moonLit = night * 0.08;

			for (let i = 0; i < sprites.length; i++) {
				const s = sprites[i];
				const mat = materials[i];
				const baseB = (mat.userData.baseBrightness ?? 0.75) as number;
				const baseO = (mat.userData.baseOpacity ?? 0.4) as number;

				// Spin & shear, both SET from the clock rather than nudged.
				mat.rotation = (baseRot[i] ?? 0) + rotSpeeds[i] * gustPhase;
				const shear = shearFactors[i] ?? 0;
				if (shear !== 0) {
					const angle = driftPhase * shear;
					const cs = Math.cos(angle);
					const sn = Math.sin(angle);
					const px = basePos[i * 2];
					const pz = basePos[i * 2 + 1];
					s.position.x = px * cs - pz * sn;
					s.position.z = px * sn + pz * cs;
				}

				// Forward Mie scatter
				_spriteWorld.copy(s.position).applyMatrix4(cloudGroup.matrixWorld);
				_viewVec.subVectors(_spriteWorld, camera.position).normalize();
				const dot = Math.max(0, _viewVec.dot(_sunDir));
				const d2 = dot * dot;
				const d6 = d2 * d2 * d2;
				const mie = d6 * mieGain;

				// 3D Sun-normal face lighting
				const nx = mat.userData.normX as number;
				const ny = mat.userData.normY as number;
				const nz = mat.userData.normZ as number;
				const sunDot = nx * _sunDir.x + ny * _sunDir.y + nz * _sunDir.z;
				const sunSide = Math.max(0, sunDot) * dayFactor * 0.35;

				// Per-channel lit composition (golden hour amber boost -> cool moonlit Rayleigh)
				const litR = baseB * (1 + liveSunBoost * 0.85 + mie * 1.5 + sunSide * 1.1);
				const litG = baseB * (1 + liveSunBoost * 0.85 + mie * 1.0 + sunSide * 1.0);
				const litB = baseB * (1 + liveSunBoost * 0.85 + mie * 0.45 + sunSide * 0.85);

				mat.color.setRGB(
					litR * nightDark + moonLit * 0.82,
					litG * nightDark * coolG + moonLit * 1.0,
					litB * nightDark * coolB + moonLit * 1.25
				);
				mat.opacity = baseO * opacityScale;
			}

			renderer.render(scene, camera);
			raf = requestAnimationFrame(renderLoop);
		};

		raf = requestAnimationFrame(renderLoop);

		return () => {
			cancelAnimationFrame(raf);
			rebuild = null;
			delete (globalThis as { __cloudSprites?: () => number }).__cloudSprites;
			materials.forEach((m) => m.dispose());
			/**
			 * Textures too, and they are the ones no JS metric will show you.
			 *
			 * `materials.dispose()` frees the material; it does NOT free the
			 * `map` each one points at. These three come from a `TextureLoader`
			 * and live in GPU memory, so a leaked texture is invisible to
			 * `performance.memory` and to a heap snapshot — measured across ten
			 * mount/unmount cycles the JS heap held flat at ~40 MB and the canvas
			 * count stayed at 4, which is exactly the reading you get whether or
			 * not this line exists.
			 *
			 * It matters here because this component really is remounted on a
			 * fielded device: the operator toggles the deck, the thermal shed
			 * flips `qualityMode`, and Stage remounts on a WebGL context loss.
			 * On a kiosk that runs for weeks between reboots, three RGBA textures
			 * per remount is a slow GPU-memory bleed ending in a context loss
			 * that reads as "the Pi crashed".
			 */
			textures.forEach((t) => t.dispose());
			textures.length = 0;
			renderer.dispose();
			scene.clear();
		};
	}

	/**
	 * Rebuilding the deck is a SEPARATE concern from owning the canvas, and
	 * that separation is what was missing.
	 *
	 * `buildCloudDeck` had exactly one call site: inside the texture loader's
	 * completion callback, which fires once. So the sprite population was fixed
	 * at load — measured at 140 sprites for `cloudDensity=0.05` and 351 for
	 * `1.0`, but only when passed in the URL before mount. Moving the operator
	 * slider afterwards changed nothing at all, because the only code that
	 * reads `density` had already run and nothing could call it again.
	 *
	 * The reads look reactive and are not, which is why review missed it: they
	 * sit inside an async callback, so they are outside the attachment's
	 * tracking scope AND outside any effect. `$derived` on line 23 makes
	 * `density` a live value that precisely one non-reactive consumer reads
	 * once.
	 *
	 * Deliberately NOT solved by taking arguments — `{@attach f(density)}` would
	 * re-run the whole attachment, tearing down the WebGL context, re-parsing
	 * three textures and rebuilding a 351-sprite scene on every slider tick.
	 * The canvas' lifetime and the deck's contents are different lifetimes, so
	 * they get different mechanisms: an attachment for the context, an effect
	 * for the population.
	 */
	let rebuild = $state<(() => void) | null>(null);

	$effect(() => {
		// The two inputs `buildCloudDeck` actually reads. `phase` is in here
		// because it seeds the RNG: at a UTC day boundary the deck must re-roll,
		// or three panes that booted on different days show different weather.
		void density;
		void qualityScale;
		void coverageScale;
		void display.phase;
		rebuild?.();
	});
</script>

{#if isVisible}
	<canvas {@attach cloudScene} class="cabin-clouds-canvas" aria-hidden="true"></canvas>
{/if}

<style>
	.cabin-clouds-canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		z-index: 3;
	}
</style>
