/**
 * The wing outside the window: aero-2's 737 wing model, fixed to the airframe,
 * merged to one draw call per material. It hangs off a seat node that follows the aircraft's heading and bank but not
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
import '@babylonjs/loaders/glTF/2.0'; // 2.0 only: the barrel also carries the glTF 1.0 loader
import { ImportMeshAsync } from '@babylonjs/core/Loading/sceneLoader';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import type { Seat } from '../visit/visit.ts';

const WING_SCALE = 10;
// In the model's own metres (root transform reset): the eye at the fuselage wall, looking out along
// +x toward the tip; +z is the nose. Which row it sits in is dealt per visit (visit/visit.ts seatFor): behind the
// wing (the classic view across the whole span), over it (the wing below the window, the tip out to
// the side), or ahead of the leading edge (the wing behind you: only the aft-looking pane sees it).
const ROW_Z: Record<Seat, number> = { behind: -5.5, over: 1.5, ahead: 9 };
const EYE_X = -8.5;
const EYE_Y = 2.4;
const TIP = new Vector3(7, 0.55, -3.5);

export async function createWing(scene: Scene, seat: Seat = 'behind') {
	const EYE = new Vector3(EYE_X, EYE_Y, ROW_Z[seat]);
	const loaded = await ImportMeshAsync('/models/wing.glb', scene);
	const root = loaded.meshes[0]!;
	// The loader's handedness flip on the root is replaced by our own mapping: model x (span) out of
	// the window; seat.scaling.x (update) puts the nose on the correct side.
	root.rotationQuaternion = null;
	root.rotation.setAll(0);
	root.scaling.setAll(1);
	// 65 meshes as exported, one draw call each: merge those sharing a material (in model space, while
	// the root is identity) so the Pi draws one per material instead.
	root.computeWorldMatrix(true);
	const byMaterial = new Map<unknown, Mesh[]>();
	for (const m of loaded.meshes) if (m instanceof Mesh && m.getTotalVertices() > 0) byMaterial.set(m.material, [...(byMaterial.get(m.material) ?? []), m]);
	const meshes = [...byMaterial.values()].map((group) => {
		const merged = group.length > 1 ? Mesh.MergeMeshes(group, true, true)! : group[0]!;
		merged.setParent(root);
		return merged;
	});
	root.rotation.set(0, -Math.PI / 2, 0);
	root.scaling.setAll(WING_SCALE);
	root.position.set(EYE.z * WING_SCALE, -EYE.y * WING_SCALE, -EYE.x * WING_SCALE);
	const mount = new TransformNode('seat', scene);
	root.parent = mount;
	const materials = new Set<PBRMaterial>();
	for (const m of meshes) {
		m.isPickable = false;
		if (m.material instanceof PBRMaterial) materials.add(m.material);
	}

	const lamp = (name: string) => {
		const ball = CreateSphere(name, { diameter: 0.3, segments: 6 }, scene);
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
		meshes: [...meshes, nav.ball, strobe.ball],
		/** Follow the airframe: `eye` the camera's position, `aircraft` heading × bank, `side` +1 right window, -1 left. */
		update(eye: Vector3, aircraft: Quaternion, side: number, nowMs: number, dark: number) {
			mount.position.copyFrom(eye);
			Quaternion.RotationYawPitchRollToRef(side * (Math.PI / 2), 0, 0, mount.rotationQuaternion ??= new Quaternion());
			aircraft.multiplyToRef(mount.rotationQuaternion, mount.rotationQuaternion);
			// Mirror so the model's nose (+z) points the way the aircraft flies: measured on screen, travel
			// and +z must share a sign (it was -side, and the wing flew backwards).
			mount.scaling.x = side;
			nav.material.emissiveColor.set(side > 0 ? 0.1 : 1, side > 0 ? 1 : 0.12, 0.1).scaleInPlace(0.3 + 0.7 * dark);
			const cycle = (nowMs % 1800) / 1800; // aero-2's double pulse
			strobe.ball.setEnabled((cycle > 0.9 && cycle < 0.93) || (cycle > 0.96 && cycle < 0.99));
			strobe.material.emissiveColor.setAll(1);
			// Shade takes the sky's light by day (see city/buildings.ts); at night a faint cool fill, as
			// moonlight and the cabin's spill catch the near metal, instead of a black cut-out.
			for (const m of materials) m.ambientColor.set(1 - dark + 0.05 * dark, 1 - dark + 0.06 * dark, 1 - dark + 0.09 * dark);
		}
	};
}
