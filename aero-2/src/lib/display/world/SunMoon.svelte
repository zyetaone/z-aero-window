<script lang="ts">
	/**
	 * SunMoon — the sun and moon as world-fixed discs inside the map.
	 *
	 * Same machinery as `Starfield.svelte` (custom `3d` layer, depth-tested
	 * against the terrain, positioned with `projectTileWithElevation`): the
	 * sun hangs off the subsolar point, the moon off its antipode, so ridges
	 * occlude them and parallax is correct. The old DOM glare washed over
	 * foreground terrain because it was screen-space; these set behind it.
	 *
	 * Two points, positions recomputed on the CPU every frame (subsolar drift
	 * is 15°/hour — a static buffer would visibly lag by evening) and pushed
	 * with a 2-point `bufferSubData`: trivially cheap, always exact.
	 *
	 * Same failure containment as Starfield: any GL failure degrades to a
	 * warn-once no-op. A missing sun is a pity; a dead map is a failure.
	 */
	import { CustomLayer } from 'svelte-maplibre-gl';
	import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from 'maplibre-gl';
	import { useDisplay } from '../display.svelte.js';
	import { antipodeOf, subSolarPoint } from './sun.js';
	import { lngLatToMercator01, starShellElevation } from './starfield.js';

	const display = useDisplay();

	interface BodyProgram {
		program: WebGLProgram;
		loc: Record<string, WebGLUniformLocation | null>;
		aPos: number;
		aBody: number;
	}

	let mapRef: MlMap | null = null;
	let posBuffer: WebGLBuffer | null = null;
	let bodyBuffer: WebGLBuffer | null = null;
	const programs = new Map<string, BodyProgram>();
	let failed = false;
	let warned = false;

	// a_body: 0 = sun, 1 = moon. Static.
	const bodyData = new Float32Array([0, 1]);
	const posData = new Float32Array(4);

	function failOnce(message: string): void {
		failed = true;
		if (!warned) {
			warned = true;
			console.warn(`[SunMoon] ${message} — discs disabled, map unaffected.`);
		}
	}

	function compileShader(
		gl: WebGL2RenderingContext,
		type: number,
		source: string
	): WebGLShader | null {
		const shader = gl.createShader(type);
		if (!shader) return null;
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
			console.warn(`[SunMoon] shader compile failed: ${gl.getShaderInfoLog(shader)}`);
			gl.deleteShader(shader);
			return null;
		}
		return shader;
	}

	function getProgram(
		gl: WebGL2RenderingContext,
		variantName: string,
		prelude: string,
		define: string
	): BodyProgram | null {
		const cached = programs.get(variantName);
		if (cached) return cached;

		const vertexSource = `#version 300 es
${prelude}
${define}
in vec2 a_pos;
in float a_body;
uniform float u_starElevation;
uniform float u_pixelRatio;
out float v_body;
void main() {
	vec4 p = projectTileWithElevation(a_pos, u_starElevation);
	// Pinned to just inside the far plane — same skybox trick as the stars
	// (see Starfield.svelte): the moon is thousands of km away laterally
	// and the ~750 km far plane would clip it silently.
	gl_Position = vec4(p.xy, p.w * 0.99999, p.w);
	gl_PointSize = (a_body < 0.5 ? 30.0 : 14.0) * u_pixelRatio;
	v_body = a_body;
}`;
		const fragmentSource = `#version 300 es
precision highp float;
in float v_body;
uniform float u_moonAlpha;
out highp vec4 fragColor;
void main() {
	float d = length(gl_PointCoord - vec2(0.5));
	vec3 col;
	float alpha;
	// Ordered smoothstep edges throughout: edge0 > edge1 is undefined
	// behaviour and evaluates to 0 on ANGLE/Metal, erasing the discs.
	if (v_body < 0.5) {
		float core = 1.0 - smoothstep(0.05, 0.16, d);
		float halo = 1.0 - smoothstep(0.08, 0.5, d);
		col = vec3(1.0, 0.95, 0.86) * core + vec3(1.0, 0.55, 0.25) * halo * 0.6;
		alpha = max(core, halo * 0.6);
	} else {
		float disc = 1.0 - smoothstep(0.2, 0.32, d);
		float halo = (1.0 - smoothstep(0.15, 0.5, d)) * 0.2;
		col = vec3(0.88, 0.91, 0.96) * disc + vec3(0.7, 0.76, 0.88) * halo;
		alpha = (disc + halo) * u_moonAlpha;
	}
	if (alpha < 0.004) discard;
	fragColor = vec4(col, alpha);
}`;

		const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
		const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
		if (!vs || !fs) {
			if (vs) gl.deleteShader(vs);
			if (fs) gl.deleteShader(fs);
			return null;
		}
		const program = gl.createProgram();
		if (!program) {
			gl.deleteShader(vs);
			gl.deleteShader(fs);
			return null;
		}
		gl.attachShader(program, vs);
		gl.attachShader(program, fs);
		gl.linkProgram(program);
		gl.deleteShader(vs);
		gl.deleteShader(fs);
		if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
			console.warn(`[SunMoon] program link failed: ${gl.getProgramInfoLog(program)}`);
			gl.deleteProgram(program);
			return null;
		}
		const uniform = (name: string) => gl.getUniformLocation(program, name);
		const entry: BodyProgram = {
			program,
			loc: {
				u_projection_fallback_matrix: uniform('u_projection_fallback_matrix'),
				u_projection_matrix: uniform('u_projection_matrix'),
				u_projection_tile_mercator_coords: uniform('u_projection_tile_mercator_coords'),
				u_projection_clipping_plane: uniform('u_projection_clipping_plane'),
				u_projection_transition: uniform('u_projection_transition'),
				u_starElevation: uniform('u_starElevation'),
				u_pixelRatio: uniform('u_pixelRatio'),
				u_moonAlpha: uniform('u_moonAlpha')
			},
			aPos: gl.getAttribLocation(program, 'a_pos'),
			aBody: gl.getAttribLocation(program, 'a_body')
		};
		programs.set(variantName, entry);
		return entry;
	}

	const implementation: Omit<CustomLayerInterface, 'id' | 'type'> = {
		renderingMode: '3d',

		onAdd(map: MlMap, gl: WebGL2RenderingContext) {
			mapRef = map;
			try {
				posBuffer = gl.createBuffer();
				bodyBuffer = gl.createBuffer();
				if (!posBuffer || !bodyBuffer) {
					failOnce('could not allocate disc buffers');
					return;
				}
				gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
				gl.bufferData(gl.ARRAY_BUFFER, posData, gl.DYNAMIC_DRAW);
				gl.bindBuffer(gl.ARRAY_BUFFER, bodyBuffer);
				gl.bufferData(gl.ARRAY_BUFFER, bodyData, gl.STATIC_DRAW);
				gl.bindBuffer(gl.ARRAY_BUFFER, null);
			} catch (err) {
				failOnce(`onAdd threw: ${err instanceof Error ? err.message : String(err)}`);
			}
		},

		onRemove(_map: MlMap, gl: WebGL2RenderingContext) {
			for (const entry of programs.values()) gl.deleteProgram(entry.program);
			programs.clear();
			if (posBuffer) gl.deleteBuffer(posBuffer);
			if (bodyBuffer) gl.deleteBuffer(bodyBuffer);
			posBuffer = null;
			bodyBuffer = null;
			mapRef = null;
			failed = false;
			warned = false;
		},

		render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
			if (failed || !posBuffer || !bodyBuffer) return;
			try {
				// Wall-shared and absolute, so the discs agree on all panes
				// without exchanging anything -- but the COMPOSED clock, not
				// `Date.now()`. A preset shifts the scene's hour, and a private
				// clock here put the disc at the real sun while the ground and
				// sky were lit for the composed one. Reading a `$derived` from
				// a render callback is just a read; it starts no reactivity.
				const sub = subSolarPoint(display.solarSec);
				const moon = antipodeOf(sub);
				const [sx, sy] = lngLatToMercator01(sub.lng, sub.lat);
				const [mx, my] = lngLatToMercator01(moon.lng, moon.lat);
				posData[0] = sx;
				posData[1] = sy;
				posData[2] = mx;
				posData[3] = my;

				const prog = getProgram(
					gl,
					args.shaderData.variantName,
					args.shaderData.vertexShaderPrelude,
					args.shaderData.define
				);
				if (!prog) {
					failOnce('program compile/link failed');
					return;
				}
				const pd = args.defaultProjectionData;
				gl.useProgram(prog.program);
				gl.uniformMatrix4fv(prog.loc.u_projection_fallback_matrix, false, pd.fallbackMatrix);
				gl.uniformMatrix4fv(prog.loc.u_projection_matrix, false, pd.mainMatrix);
				gl.uniform4f(prog.loc.u_projection_tile_mercator_coords, ...pd.tileMercatorCoords);
				gl.uniform4f(prog.loc.u_projection_clipping_plane, ...pd.clippingPlane);
				gl.uniform1f(prog.loc.u_projection_transition, pd.projectionTransition);
				gl.uniform1f(prog.loc.u_starElevation, starShellElevation(args.farZ));
				const canvas = mapRef?.getCanvas() ?? null;
				const px =
					canvas && canvas.clientHeight > 0 ? gl.drawingBufferHeight / canvas.clientHeight : 1;
				gl.uniform1f(prog.loc.u_pixelRatio, px);
				// The moon is always full here (antipode simplification), so
				// it shows faintly by day and fully at night.
				gl.uniform1f(prog.loc.u_moonAlpha, 0.2 + 0.8 * Math.min(1, Math.max(0, display.night)));

				gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
				gl.bufferSubData(gl.ARRAY_BUFFER, 0, posData);
				gl.enableVertexAttribArray(prog.aPos);
				gl.vertexAttribPointer(prog.aPos, 2, gl.FLOAT, false, 0, 0);
				gl.bindBuffer(gl.ARRAY_BUFFER, bodyBuffer);
				gl.enableVertexAttribArray(prog.aBody);
				gl.vertexAttribPointer(prog.aBody, 1, gl.FLOAT, false, 0, 0);

				gl.depthMask(false);
				// Same stale-scissor guard as the stars (see Starfield.svelte):
				// the painter leaves tile-clipping state behind for custom
				// layers, which would clip the discs with no error.
				const scissorWas = gl.isEnabled(gl.SCISSOR_TEST);
				const stencilWas = gl.isEnabled(gl.STENCIL_TEST);
				gl.disable(gl.SCISSOR_TEST);
				gl.disable(gl.STENCIL_TEST);
				gl.enable(gl.BLEND);
				gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
				gl.drawArrays(gl.POINTS, 0, 2);
				if (scissorWas) gl.enable(gl.SCISSOR_TEST);
				if (stencilWas) gl.enable(gl.STENCIL_TEST);
				gl.depthMask(true);
				gl.bindBuffer(gl.ARRAY_BUFFER, null);
			} catch (err) {
				failOnce(`render threw: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	};
</script>

<!-- Beside the stars, before the ground photograph: discs are sky, occluded
     by everything after them. -->
<CustomLayer id="sun-moon" beforeId="gibs-day" {implementation} />
