<script lang="ts">
	/**
	 * Wing — High-Fidelity 3D Boeing 737 aircraft wing rendered in the passenger window.
	 *
	 * Uses Three.js WebGL with upward dihedral sweep, wingtip navigation light (port red),
	 * double-pulse strobe beacon, and dynamic specular lighting reflecting solar time.
	 * Responds dynamically to airframe banking, solar lighting transitions, and operator alignment knobs.
	 */
	import { useDisplay } from '../display.svelte.js';
	import { WORLD_ROLL_GAIN } from '../flight/view.js';
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
		ACESFilmicToneMapping,
		AmbientLight,
		Color,
		DirectionalLight,
		DoubleSide,
		Group,
		Mesh,
		Object3D,
		PerspectiveCamera,
		PointLight,
		Scene,
		WebGLRenderer
	} from 'three';
	import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

	const display = useDisplay();

	const isVisible = $derived(display.config.wing);
	const scale = $derived(display.config.wingScale);
	const offsetX = $derived(display.config.wingOffsetX);
	const offsetY = $derived(display.config.wingOffsetY);
	const pitchOffset = $derived(display.config.wingPitchDeg);
	const yawOffset = $derived(display.config.wingYawDeg);
	const rollFactor = $derived(display.config.wingRollFactor);

	/**
	 * The scene's whole life, attached to the canvas that owns it.
	 *
	 * This was `bind:this` into a nullable `$state`, plus an `$effect` that
	 * re-checked both the element and `isVisible` before doing anything. The
	 * element is not really state -- it exists exactly as long as the `{#if}`
	 * below says it does, which is the same lifetime as the renderer. An
	 * attachment says that directly: it runs when the canvas mounts, and its
	 * return value runs when the canvas goes away.
	 *
	 * It takes NO arguments on purpose. `{@attach f(x)}` re-runs whenever `x`
	 * changes, and rebuilding a WebGL context and re-parsing the GLTF every
	 * time an operator nudges a slider would be a serious regression. Every
	 * knob is read inside the render loop below, where reads are untracked and
	 * cost nothing.
	 */
	function wingScene(c: HTMLCanvasElement) {
		const renderer = new WebGLRenderer({
			canvas: c,
			alpha: true,
			antialias: true,
			powerPreference: 'high-performance'
		});
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.setSize(c.clientWidth, c.clientHeight, false);
		renderer.toneMapping = ACESFilmicToneMapping;
		renderer.toneMappingExposure = 1.15;

		const scene = new Scene();
		// Expanded frustum and depth bounds: zero edge clipping across all aspect ratios
		const camera = new PerspectiveCamera(52, c.clientWidth / c.clientHeight, 0.001, 1000);
		camera.position.set(0, 0, 6.2);

		/**
		 * Solar lighting, actually solar.
		 *
		 * These two intensities were constants -- 0.9 and 2.2 -- while this
		 * file's own docstring promised "dynamic specular lighting reflecting
		 * solar time". At `?preset=gulf-midnight` the result was a wing lit like
		 * noon, pasted on a starfield over a black Persian Gulf: the single most
		 * obviously wrong thing in the night window.
		 *
		 * Set once here, driven per frame in the render loop below off
		 * `display.night`, which is the same 0..1 the ground grade and the
		 * starfield already ramp on, so the wing goes out with the sky rather
		 * than on a schedule of its own.
		 */
		const ambient = new AmbientLight(0xffffff, 0.9);
		scene.add(ambient);

		const sunKey = new DirectionalLight(0xffeedd, 2.2);
		sunKey.position.set(6, 9, 5);
		scene.add(sunKey);

		/** Warm noon key vs. cold moonlight, and the ambient that survives dusk. */
		const SUN_COLOR = new Color(0xffeedd);
		const MOON_COLOR = new Color(0x9fb6da);

		/**
		 * Model yaw, radians (≈300°).
		 *
		 * `wing.glb` is not a wing — it is a whole Sketchfab 737 (CC-BY-4.0),
		 * 35 m across in cm units, nose toward model +Z (fin at the −Z end),
		 * shrunk to metres by its own root node. The old 1.68 rad (≈96°)
		 * combined with the z-mirror below put the NOSE behind the camera
		 * and framed the tail: projected through this exact chain the nose
		 * lands at z=7.3 against a camera at z=6.2, so the aircraft read as
		 * flying tail-first. Proven by composing the chain headlessly
		 * (three.js math, no renderer) over the landmarks nose (0.55,·),
		 * tip (−0.37,·), belly (0.11,·) in NDC at 300° — nose right-forward,
		 * wing sweeping lower-left, engines and fin behind the camera and
		 * out of sight. Re-derive the same way if the model or framing
		 * ever changes; eyeballing Euler triples is how it broke.
		 */
		const WING_YAW = 5.24;

		const wingHolder = new Group();
		// Base positioning: Root in lower right, wing sweeping into camera depth
		wingHolder.position.set(1.1, -1.1, 0);
		scene.add(wingHolder);

		// Wingtip Strobe & Nav Light in 3D
		const strobeLight = new PointLight(0xffffff, 0, 30);
		strobeLight.position.set(-13.7, -4.7, -27.4);
		wingHolder.add(strobeLight);

		/**
		 * Wingtip lights ride the SHOWN tip in holder space, not the origin.
		 *
		 * The tip landmark (model −X extreme) sits at (−13.7, −5.6, −27.4)
		 * in holder units under the yaw below; the old (−2.6, 0.85, −1.6)
		 * was placed for the previous composition and lit empty air near
		 * the fuselage instead. Distances cover the ~24-unit camera range.
		 */
		const TIP_POS: [number, number, number] = [-13.7, -4.7, -27.4];
		const navLight = new PointLight(0x22c55e, 1.5, 10);
		navLight.position.set(...TIP_POS);
		wingHolder.add(navLight);

		let wingMesh: Object3D | null = null;
		const loader = new GLTFLoader();

		loader.load(
			'/models/wing.glb',
			(gltf) => {
				wingMesh = gltf.scene;
				// Yaw ≈300°: nose-forward left-window composition. See WING_YAW.
				wingMesh.rotation.set(0.02, WING_YAW, 0.18);
				wingMesh.scale.set(1.11, 1.11, -1.11);
				wingMesh.traverse((child) => {
					if (child instanceof Mesh && child.material) {
						child.material.side = DoubleSide;
					}
				});
				wingHolder.add(wingMesh);
			},
			undefined,
			(err) => {
				console.warn('[Wing] 3D wing.glb load warning:', err);
			}
		);

		let raf: number;

		const renderLoop = (now: number) => {
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

			/**
			 * Take the sun off the wing as the sky loses it.
			 *
			 * The key light does not fade to nothing: a wing at cruise altitude
			 * still catches moon and skyglow, and a truly black wing reads as a
			 * missing object rather than a dark one. It fades to a tenth, and
			 * turns cold on the way -- the colour shift is what sells night more
			 * than the level does.
			 */
			const night = display.night;
			ambient.intensity = 0.9 - night * 0.74;
			sunKey.intensity = 2.2 * (1 - night * 0.9);
			sunKey.color.copy(SUN_COLOR).lerp(MOON_COLOR, night);

			// Strobe flash double-pulse pattern (every 1.8 seconds)
			const strobeCycle = (now % 1800) / 1800;
			if ((strobeCycle > 0.9 && strobeCycle < 0.93) || (strobeCycle > 0.96 && strobeCycle < 0.99)) {
				strobeLight.intensity = 8.0;
			} else {
				strobeLight.intensity = 0.0;
			}

			if (wingMesh) {
				const sweepRad = WING_YAW + (yawOffset * Math.PI) / 180;
				wingMesh.rotation.set(0.02, sweepRad, 0.18);
			}

			if (wingHolder) {
				const bank = display.view.bankDeg;
				const screenSign = display.config.direction < 0 ? -1 : 1;
				// In airframe-relative cabin space, the wing is rigidly mounted to the fuselage outside the window.
				// Aeroelastic wingtip flex: under banking lift loads, the wing flexes subtly (0.04 factor).
				const aeroFlexDeg = bank * 0.04 * rollFactor;
				const currentPitchRad = ((pitchOffset + aeroFlexDeg) * Math.PI) / 180;

				/**
				 * The wing is RIGIDLY mounted, so it must roll with the airframe.
				 *
				 * It used to move by the aeroelastic flex term alone — 0.72 deg at
				 * a full 18 deg bank — while the camera swung 6 deg of depression.
				 * A wing that barely moves while the view swings reads as pasted
				 * onto the glass, which is the loudest tell that this is a map.
				 *
				 * The world now rolls at WORLD_ROLL_GAIN (one home, in flight/view).
				 * This is
				 * the OPPOSITE sign and the same gain: the wing is fixed to the
				 * aircraft, so in cabin space the horizon rotates one way and the
				 * airframe stays put — which on screen means the wing counter-
				 * rotates against the tilting world by exactly what the world
				 * moved. Any other gain and the wing drifts against its own
				 * horizon through every turn.
				 *
				 * `screenSign` mirrors it for a reversed loop, as with everything
				 * else here: the window is on the inside of the turn either way,
				 * so the wing hangs off the other side of the frame.
				 */
				const worldRollRad = (bank * WORLD_ROLL_GAIN * Math.PI) / 180;

				// Rigid cabin airframe lock with aeroelastic lift flex
				wingHolder.rotation.z = -currentPitchRad * screenSign + worldRollRad * screenSign;
				wingHolder.scale.set(scale * screenSign, scale, scale);

				// Locked 3D translation inside cabin reference frame with high-frequency aero-flutter
				const flutter = display.view.turbulence.wingFlutterPx * 0.0015;
				wingHolder.position.set(
					1.1 * screenSign + offsetX * 0.005 * screenSign,
					-1.1 - offsetY * 0.005 + flutter,
					0
				);

				// Aviation Standard: green starboard, red port. The composition is
				// a LEFT-window view (nose right), so the shown tip is port:
				// red by default, green when the reversed loop mirrors to the
				// other side of the aircraft.
				navLight.color.setHex(screenSign > 0 ? 0xef4444 : 0x22c55e);
			}

			renderer.render(scene, camera);
			raf = requestAnimationFrame(renderLoop);
		};

		raf = requestAnimationFrame(renderLoop);

		return () => {
			cancelAnimationFrame(raf);
			/**
			 * A glTF is geometries, materials AND textures, and `scene.clear()`
			 * frees none of them.
			 *
			 * `clear()` detaches children from the graph; the GPU buffers behind
			 * them live until something calls `dispose()` on each one. So every
			 * remount of this component orphaned a full wing model — vertex
			 * buffers, materials, and whatever textures the asset carries.
			 *
			 * None of that shows up in `performance.memory` or a heap snapshot,
			 * because it is GPU memory. Measured across ten mount/unmount cycles
			 * the JS heap was flat and the canvas count constant, which is the
			 * same reading a correct teardown gives — the leak is only visible as
			 * a context loss weeks later on a device that never reboots.
			 *
			 * `traverse` rather than a flat loop because a glTF scene is a TREE:
			 * `wing.glb` puts its meshes under nested nodes, so iterating
			 * `scene.children` would miss the ones that actually hold the data.
			 */
			scene.traverse((obj) => {
				if (!(obj instanceof Mesh)) return;
				obj.geometry?.dispose?.();
				const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
				for (const m of mats) {
					if (!m) continue;
					// Every texture-ish slot a standard glTF material can carry.
					for (const slot of [
						'map',
						'normalMap',
						'roughnessMap',
						'metalnessMap',
						'emissiveMap',
						'aoMap',
						'alphaMap'
					] as const) {
						(m as unknown as Record<string, { dispose?: () => void } | null>)[slot]?.dispose?.();
					}
					m.dispose();
				}
			});
			renderer.dispose();
			scene.clear();
		};
	}
</script>

{#if isVisible}
	<!-- Pure 3D WebGL Canvas Layer (Unclipped 100% Viewport Bounds) -->
	<canvas {@attach wingScene} class="cabin-wing-canvas" aria-hidden="true"></canvas>
{/if}

<style>
	.cabin-wing-canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
		z-index: 5;
	}
</style>
