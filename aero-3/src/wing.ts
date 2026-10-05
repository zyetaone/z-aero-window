/**
 * The wing outside the window: aero-2's 737 wing model, fixed to the airframe.
 * It hangs off a seat node that follows the aircraft's heading and bank but not
 * the eye's pan or the pane's yaw, so the gaze moves across a still wing and the
 * side panes see it from their own angle, as side windows do.
 *
 * Drawn WING_SCALE times life size and that many times further out: the
 * picture is identical, and it clears the camera's 10 m near plane, which a
 * real wing 3 m from the glass would not. A window on the other side gets the
 * same wing mirrored. Nav light at the tip (green starboard, red port) and
 * aero-2's double-pulse strobe, both on the wall clock.
 *
 * Model: CC-BY-4.0, by "A Random Modeler" on Sketchfab (danielskom111), via aero-2.
 */
import '@babylonjs/loaders/glTF';
import { ImportMeshAsync, MeshBuilder, PBRMaterial, Quaternion, StandardMaterial, TransformNode, Vector3, type Scene } from '@babylonjs/core';

const WING_SCALE = 10;
// In the model's own metres (root transform reset): the eye at the fuselage wall, just behind the
// trailing edge and above it, looking out along +x toward the tip; +z is the nose. And the wingtip light.
const EYE = new Vector3(-8.5, 2.4, -5.5);
const TIP = new Vector3(7, 0.55, -3.5);

export async function wing(scene: Scene) {
	const { meshes } = await ImportMeshAsync('/models/wing.glb', scene);
	const root = meshes[0]!;
	// The loader's handedness flip on the root is replaced by our own mapping: model x (span) out of
	// the window; seat.scaling.x (update) puts the nose on the correct side.
	root.rotationQuaternion = null;
	root.rotation.set(0, -Math.PI / 2, 0);
	root.scaling.setAll(WING_SCALE);
	root.position.set(EYE.z * WING_SCALE, -EYE.y * WING_SCALE, -EYE.x * WING_SCALE);
	const seat = new TransformNode('seat', scene);
	root.parent = seat;
	const materials = new Set<PBRMaterial>();
	for (const m of meshes) {
		m.isPickable = false;
		if (m.material instanceof PBRMaterial) materials.add(m.material);
	}

	const lamp = (name: string) => {
		const ball = MeshBuilder.CreateSphere(name, { diameter: 0.3, segments: 6 }, scene);
		const material = new StandardMaterial(name, scene);
		material.disableLighting = true;
		ball.material = material;
		ball.parent = root;
		ball.position.copyFrom(TIP);
		ball.isPickable = false;
		return { ball, material };
	};
	const [nav, strobe] = [lamp('nav-light'), lamp('strobe')];
	strobe.ball.position.x += 0.4;

	return {
		/** Everything that should block the bloom, lights included. */
		meshes: [...meshes.filter((m) => m.getTotalVertices() > 0), nav.ball, strobe.ball],
		/** Follow the airframe: `eye` the camera's position, `aircraft` heading × bank, `side` +1 right window, -1 left. */
		update(eye: Vector3, aircraft: Quaternion, side: number, nowMs: number, dark: number) {
			seat.position.copyFrom(eye);
			Quaternion.RotationYawPitchRollToRef(side * (Math.PI / 2), 0, 0, seat.rotationQuaternion ??= new Quaternion());
			aircraft.multiplyToRef(seat.rotationQuaternion, seat.rotationQuaternion);
			seat.scaling.x = -side; // the model's nose (+z) to the left of a right-side window; mirrored for the left
			nav.material.emissiveColor.set(side > 0 ? 0.1 : 1, side > 0 ? 1 : 0.12, 0.1).scaleInPlace(0.3 + 0.7 * dark);
			const cycle = (nowMs % 1800) / 1800; // aero-2's double pulse
			strobe.ball.setEnabled((cycle > 0.9 && cycle < 0.93) || (cycle > 0.96 && cycle < 0.99));
			strobe.material.emissiveColor.setAll(1);
			// Shade takes the sky's light by day (see buildings.ts); at night a faint cool fill, as
			// moonlight and the cabin's spill catch the near metal, instead of a black cut-out.
			for (const m of materials) m.ambientColor.set(1 - dark + 0.05 * dark, 1 - dark + 0.06 * dark, 1 - dark + 0.09 * dark);
		}
	};
}
