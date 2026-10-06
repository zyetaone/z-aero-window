/**
 * The haze over a lit city at night: one additive sheet a few hundred metres
 * above the near patch, carrying ground/terrain.ts's light dome (VIIRS blurred, broken
 * up by noise). From the window it is the amber murk a city sits in, softening
 * the lamps under it and glowing where the city is densest. Bent by the same
 * curvature as the ground, so it hugs the horizon instead of flying off it.
 */
import { Color3, Constants, MeshBuilder, StandardMaterial, Texture, VertexBuffer, type Scene } from '@babylonjs/core';

const ABOVE_M = 450; // the haze layer's height over the ground at the centre

export async function haze(scene: Scene, map: OffscreenCanvas, sizeM: number, groundM: number, drop: (x: number, z: number) => number) {
	const sheet = MeshBuilder.CreateGround('haze', { width: sizeM, height: sizeM, subdivisions: 48, updatable: true }, scene);
	const positions = sheet.getVerticesData(VertexBuffer.PositionKind)!;
	for (let i = 0; i < positions.length; i += 3) positions[i + 1] = groundM + ABOVE_M - drop(positions[i]!, positions[i + 2]!);
	sheet.updateVerticesData(VertexBuffer.PositionKind, positions);
	sheet.refreshBoundingInfo();
	sheet.isPickable = false;
	sheet.freezeWorldMatrix();

	const url = URL.createObjectURL(await map.convertToBlob({ type: 'image/png' }));
	const material = new StandardMaterial('haze', scene);
	material.disableLighting = true;
	material.emissiveTexture = new Texture(url, scene);
	material.emissiveTexture.wrapU = material.emissiveTexture.wrapV = Texture.CLAMP_ADDRESSMODE;
	material.diffuseColor = Color3.Black();
	material.emissiveColor = Color3.Black(); // the texture is the light; its level is the gain
	material.alphaMode = Constants.ALPHA_ONEONE;
	// Below 1, or Babylon draws it in the OPAQUE pass, where ONEONE never applies: it painted a black
	// square over the whole near patch from dusk on (the 'terrain goes black at 17:24' bug).
	material.alpha = 0.999;
	material.disableDepthWrite = true;
	material.backFaceCulling = false;
	sheet.material = material;

	return (gain: number) => {
		sheet.setEnabled(gain > 0.002);
		material.emissiveTexture!.level = gain; // StandardMaterial adds an emissive texture at its level, not × emissiveColor
	};
}
