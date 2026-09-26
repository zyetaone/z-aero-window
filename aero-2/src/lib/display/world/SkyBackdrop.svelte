<script lang="ts">
	/**
	 * SkyBackdrop — a fullscreen sky gradient underneath the map.
	 *
	 * WHY A SECOND SKY: MapLibre's own sky shader ends with
	 * `mix(skyColor, transparent, u_sky_blend)`, where `u_sky_blend` is the
	 * globe↔mercator projection transition — 1 in the settled globe view the
	 * kiosk flies. So the dome's gradient is mixed to transparent exactly
	 * where we look at it, and only the limb atmosphere-glow (transparent at
	 * zenith) remains: the zenith renders canvas-black at 30,000 ft in
	 * daylight, while the same colours read blue at close-up where the
	 * transition rests at 0. This layer paints the same circadian colours
	 * (see `sky-colors.ts`) as an opaque backstop, drawn first, so the sky
	 * is blue at every altitude. Where the dome does paint (close zoom) it
	 * draws the same colours over the top — agreement by construction.
	 *
	 * Same failure containment as Starfield: GL trouble degrades to a
	 * warn-once no-op, never a dead window.
	 */
	import { CustomLayer } from 'svelte-maplibre-gl';
	import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from 'maplibre-gl';
	import { useDisplay } from '../display.svelte.js';
	import {
		resolveSkyHorizonColor,
		resolveSkyTopColor,
		skyGradientTopPct,
		skyHorizonPct
	} from './sky-colors.js';
	import { weatherLightLoss } from './atmosphere.js';

	const display = useDisplay();

	let program: WebGLProgram | null = null;
	let triBuffer: WebGLBuffer | null = null;
	let failed = false;
	let warned = false;

	function failOnce(message: string): void {
		failed = true;
		if (!warned) {
			warned = true;
			console.warn(`[SkyBackdrop] ${message} — sky backstop disabled, map unaffected.`);
		}
	}

	function getProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
		if (program) return program;
		const vertexSource = `#version 300 es
in vec2 a_pos;
out float v_y;
void main() {
	v_y = a_pos.y * 0.5 + 0.5;
	gl_Position = vec4(a_pos, 0.0, 1.0);
}`;
		/**
		 * Gradient in screen space, not world space: this is the backstop
		 * behind everything, and the horizon it meets is where the MAP puts
		 * the terrain edge, which the tuned `horizonPct` already names. The
		 * span is wider than any plausible horizon error so a mistune hides
		 * behind opaque ground instead of banding the sky.
		 */
		const fragmentSource = `#version 300 es
precision highp float;
in float v_y;
uniform vec3 u_top;
uniform vec3 u_horizon;
uniform float u_horizon_y;
uniform float u_top_y;
out highp vec4 fragColor;
void main() {
	float t = clamp((v_y - u_horizon_y) / max(1e-3, u_top_y - u_horizon_y), 0.0, 1.0);
	t = t * t * (3.0 - 2.0 * t);
	fragColor = vec4(mix(u_horizon, u_top, t), 1.0);
}`;
		const compile = (type: number, source: string): WebGLShader | null => {
			const shader = gl.createShader(type);
			if (!shader) return null;
			gl.shaderSource(shader, source);
			gl.compileShader(shader);
			if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
				console.warn(`[SkyBackdrop] shader compile failed: ${gl.getShaderInfoLog(shader)}`);
				gl.deleteShader(shader);
				return null;
			}
			return shader;
		};
		const vs = compile(gl.VERTEX_SHADER, vertexSource);
		const fs = compile(gl.FRAGMENT_SHADER, fragmentSource);
		if (!vs || !fs) {
			if (vs) gl.deleteShader(vs);
			if (fs) gl.deleteShader(fs);
			return null;
		}
		const prog = gl.createProgram();
		if (!prog) {
			gl.deleteShader(vs);
			gl.deleteShader(fs);
			return null;
		}
		gl.attachShader(prog, vs);
		gl.attachShader(prog, fs);
		gl.linkProgram(prog);
		gl.deleteShader(vs);
		gl.deleteShader(fs);
		if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
			console.warn(`[SkyBackdrop] program link failed: ${gl.getProgramInfoLog(prog)}`);
			gl.deleteProgram(prog);
			return null;
		}
		program = prog;
		return prog;
	}

	const implementation: Omit<CustomLayerInterface, 'id' | 'type'> = {
		renderingMode: '2d',

		onAdd(_map: MlMap, gl: WebGL2RenderingContext) {
			try {
				triBuffer = gl.createBuffer();
				if (!triBuffer) {
					failOnce('could not allocate backdrop buffer');
					return;
				}
				gl.bindBuffer(gl.ARRAY_BUFFER, triBuffer);
				gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
				gl.bindBuffer(gl.ARRAY_BUFFER, null);
			} catch (err) {
				failOnce(`onAdd threw: ${err instanceof Error ? err.message : String(err)}`);
			}
		},

		onRemove(_map: MlMap, gl: WebGL2RenderingContext) {
			if (program) gl.deleteProgram(program);
			if (triBuffer) gl.deleteBuffer(triBuffer);
			program = null;
			triBuffer = null;
			failed = false;
			warned = false;
		},

		render(gl: WebGL2RenderingContext, _args: CustomRenderMethodInput) {
			if (failed || !triBuffer) return;
			try {
				const prog = getProgram(gl);
				if (!prog) {
					failOnce('program compile/link failed');
					return;
				}
				// Same inputs as the dome: one sky, two painters.
				const overcast = weatherLightLoss(display.weather);
				const inputs = {
					baseTop: display.atmosphere.skyTop,
					baseHorizon: display.atmosphere.skyHorizon,
					sunElevDeg: display.sun.elevationDeg,
					night: display.night,
					overcast,
					placeId: display.config.place.id
				};
				const top = resolveSkyTopColor(inputs);
				const horizon = resolveSkyHorizonColor(inputs);
				const horizonPct = skyHorizonPct(display.view.cameraPitchDeg);
				// Percentage-from-top to fraction-from-bottom for the shader.
				const horizonY = 1 - horizonPct / 100;
				const topY = 1 - skyGradientTopPct(horizonPct) / 100;

				gl.useProgram(prog);
				gl.uniform3f(gl.getUniformLocation(prog, 'u_top'), top[0], top[1], top[2]);
				gl.uniform3f(gl.getUniformLocation(prog, 'u_horizon'), horizon[0], horizon[1], horizon[2]);
				gl.uniform1f(gl.getUniformLocation(prog, 'u_horizon_y'), horizonY);
				gl.uniform1f(gl.getUniformLocation(prog, 'u_top_y'), topY);

				gl.bindBuffer(gl.ARRAY_BUFFER, triBuffer);
				const aPos = gl.getAttribLocation(prog, 'a_pos');
				gl.enableVertexAttribArray(aPos);
				gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

				// Fullscreen backstop: no depth test (the ground covers us
				// where it stands), and the same stale-scissor guard as
				// Starfield — the painter leaves clipping state behind and
				// never resets it for custom layers.
				const depthWas = gl.isEnabled(gl.DEPTH_TEST);
				const scissorWas = gl.isEnabled(gl.SCISSOR_TEST);
				const blendWas = gl.isEnabled(gl.BLEND);
				gl.disable(gl.DEPTH_TEST);
				gl.depthMask(false);
				gl.disable(gl.SCISSOR_TEST);
				gl.disable(gl.BLEND);
				gl.drawArrays(gl.TRIANGLES, 0, 3);
				if (depthWas) gl.enable(gl.DEPTH_TEST);
				if (scissorWas) gl.enable(gl.SCISSOR_TEST);
				if (blendWas) gl.enable(gl.BLEND);
				gl.depthMask(true);
				gl.bindBuffer(gl.ARRAY_BUFFER, null);
			} catch (err) {
				failOnce(`render threw: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	};
</script>

<!-- First of all: below the stars, sun, moon and ground photo. `beforeId`
     inserts stack in mount order ahead of the anchor, so this component must
     be mounted BEFORE Starfield in Stage.svelte or the gradient covers the
     stars. -->
<CustomLayer id="sky-backdrop" beforeId="gibs-day" {implementation} />
