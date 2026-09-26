<script lang="ts">
	/**
	 * Wing — High-Fidelity 3D Boeing 737 aircraft wing rendered in the passenger window.
	 *
	 * Uses Three.js WebGL with upward dihedral sweep, wingtip navigation light (port red),
	 * double-pulse strobe beacon, and dynamic specular lighting reflecting solar time.
	 * Responds dynamically to airframe banking, solar lighting transitions, and operator alignment knobs.
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
		ACESFilmicToneMapping,
		AmbientLight,
		Color,
		DirectionalLight,
		DoubleSide,
		Group,
		Mesh,
		Object3D,
		PerspectiveCamera,
		Plane,
		PointLight,
		Scene,
		Vector3,
		WebGLRenderer,
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
		 * Pose, derived from the model's own frame, no mirror.
		 *
		 * `wing.glb` is a whole Sketchfab 737 (CC-BY-4.0) in cm, nose toward
		 * model +Z, up +Y, shrunk to metres by its `right_normalize` root. The
		 * detailed wing (engine, winglet, gear) is on model +X, which in a
		 * right-handed Y-up frame with the nose at +Z is the LEFT wing. So the
		 * left-window composition needs no mirror: yaw +90° about Y sends the
		 * wing (+X) away from the camera (−Z) and the nose (+Z) to the right.
		 *
		 * The old pose (yaw 300°, scale.z −1.11) mirrored the model to fake a
		 * left wing it already had, and framed it from the wingtip looking back
		 * at the root, from below. Measured 2026-09-23 with a yaw sweep: the
		 * winglet sat nearest the camera and the flap-track fairings faced it.
		 *
		 * Placement was measured, not derived: the wing skin's world box was
		 * read back through a DEV handle (`__wing`) and the offsets solved for a
		 * seat just behind the wing, eye ~0.5 m above the wing top, fuselage
		 * centreline 1.5 m behind the camera. The model's bare right wing and
		 * centre section continue past the camera and are removed by the
		 * clipping plane at the cabin wall. The engine sits below the sill.
		 */
		const WING_YAW = Math.PI / 2;
		const MODEL_SCALE = 1.11;
		/** Model-metre offsets (after right_normalize) that land the root where a window seat sees it. */
		const WING_POS: [number, number, number] = [-4.8, -0.4, -1.2];
		/** Fuselage wall in scene z: everything nearer the camera than this is inside the cabin. */
		const WALL_Z = 5.8;

		const wingHolder = new Group();
		// Base positioning: Root in lower right, wing sweeping into camera depth
		wingHolder.position.set(1.1, -1.1, 0);
		scene.add(wingHolder);
		renderer.localClippingEnabled = false;
		renderer.clippingPlanes = [new Plane(new Vector3(0, 0, -1), WALL_Z)];

		// Wingtip strobe and nav light, parented to the model's tip vertex at load
		// (cm, the model's own units), so they ride the tip under any pose.
		const strobeLight = new PointLight(0xffffff, 0, 30);
		const navLight = new PointLight(0x22c55e, 1.5, 10);

		let wingMesh: Object3D | null = null;
		const loader = new GLTFLoader();

		loader.load(
			'/models/wing.glb',
			(gltf) => {
				wingMesh = gltf.scene;
				wingMesh.rotation.set(0, WING_YAW, 0);
				wingMesh.scale.setScalar(MODEL_SCALE);
				wingMesh.position.set(...WING_POS);
				const modelRoot = wingMesh.children[0] ?? wingMesh;
				navLight.position.set(1646, 400, -5600);
				strobeLight.position.set(1646, 410, -5560);
				modelRoot.add(navLight, strobeLight);
				let hidden = 0;
				wingMesh.traverse((child) => {
					if (!(child instanceof Mesh)) return;
					if (child.material) child.material.side = DoubleSide;
					/**
					 * The glTF is a whole 737 on the ground: the main gear is down
					 * (wheels at model y≈0, the wing box at y≈170-400 cm) and was
					 * hanging under the wing in cruise. Anything whose top sits below
					 * the wing's belly is gear, gear door or ground strake: hidden.
					 */
					child.geometry.computeBoundingBox();
					const bb = child.geometry.boundingBox!;
					if (bb.max.y < 130) {
						child.visible = false;
						hidden++;
					}
					/**
					 * Nacelle decals (lettering and logo, geometry not texture) are
					 * hidden: the airline mark belongs to a texture the operator
					 * supplies, not to a CC-BY model. The nacelle stays plain blue.
					 */
					if (/^Group_072_/.test(child.name) && !/Material24|0131_Silver/.test(child.name)) {
						child.visible = false;
						hidden++;
					}
				});
				if (import.meta.env.DEV) {
					console.warn(`[Wing] posed; hid ${hidden} meshes`);
					(globalThis as unknown as { __wing?: unknown }).__wing = { scene, camera, renderer, wingHolder, wingMesh };
				}
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
				wingMesh.rotation.set(0, sweepRad, 0);
			}

			if (wingHolder) {
				const bank = display.view.bankDeg;
				const screenSign = display.config.direction < 0 ? -1 : 1;
				// In airframe-relative cabin space, the wing is rigidly mounted to the fuselage outside the window.
				// Aeroelastic wingtip flex: under banking lift loads, the wing flexes subtly (0.04 factor).
				const aeroFlexDeg = bank * 0.04 * rollFactor;
				const currentPitchRad = ((pitchOffset + aeroFlexDeg) * Math.PI) / 180;

				/**
				 * The wing is rigid to the airframe, and so is the window bezel the
				 * camera sits in. In cabin space neither moves under bank: the
				 * HORIZON rolls (the map's world-roll gain, in flight/view), the wing and the frame
				 * stay put. This used to add the world's roll to the wing, which made
				 * the wing swing against its own bezel through every turn. Only the
				 * aeroelastic flex and the operator's pitch knob remain.
				 */
				wingHolder.rotation.z = -currentPitchRad * screenSign;
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
