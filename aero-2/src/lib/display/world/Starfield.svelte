<script lang="ts">
	/**
	 * Starfield — the night sky, drawn INSIDE the map where it belongs.
	 *
	 * A `custom` style layer with `renderingMode: '3d'`, mounted above the
	 * SkyBackdrop gradient (beforeId `gibs-day`), following the official MapLibre globe
	 * custom-layer pattern verbatim: vertex shader = injected
	 * `vertexShaderPrelude` + `define`, positions via `projectTileWithElevation`
	 * (present in both globe and mercator preludes, so projection transitions
	 * keep working), the five projection uniforms re-set every frame from
	 * `args.defaultProjectionData`, one compiled program per
	 * `shaderData.variantName`.
	 *
	 * Why in-map instead of the old DOM overlay: the overlay sat ABOVE the map
	 * canvas and could only hide behind a flat mask line, so relief and roll
	 * put stars over terrain. In-map, stars share the depth buffer with the
	 * terrain (`depthRangeFor3D` is one shared range, not per-layer slices),
	 * sit on a 2,000 km shell, and the globe prelude clips everything behind
	 * the horizon for free — occlusion is computed per pixel, not guessed per
	 * frame. No mask, no roll tracking, nothing to drift.
	 *
	 * Failure containment: GL compile can fail on a Pi driver quirk and a
	 * per-frame throw would poison the whole map loop, so both paths degrade
	 * to a warn-once no-op. Worst case is the old sky without stars, never a
	 * dead window.
	 */
	import { CustomLayer } from 'svelte-maplibre-gl';
	import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from 'maplibre-gl';
	import { useDisplay } from '../display.svelte.js';
	import { buildStarField, STAR_COUNT, starShellElevation } from './starfield.js';

	const display = useDisplay();

	interface StarProgram {
		program: WebGLProgram;
		loc: Record<string, WebGLUniformLocation | null>;
		aPos: number;
		aStar: number;
	}

	// Built once per mount: same seed on every pane, so the wall agrees star
	// for star without exchanging anything.
	const field = buildStarField();
	const posData = field.xy;
	const starData = new Float32Array(STAR_COUNT * 4);
	for (let i = 0; i < STAR_COUNT; i++) {
		starData[i * 4] = field.size[i];
		starData[i * 4 + 1] = field.mag[i];
		starData[i * 4 + 2] = field.phase[i];
		starData[i * 4 + 3] = field.temp[i];
	}

	let mapRef: MlMap | null = null;
	let posBuffer: WebGLBuffer | null = null;
	let starBuffer: WebGLBuffer | null = null;
	const programs = new Map<string, StarProgram>();
	let failed = false;
	let warned = false;

	function failOnce(message: string): void {
		failed = true;
		if (!warned) {
			warned = true;
			console.warn(`[Starfield] ${message} — night sky disabled, map unaffected.`);
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
			console.warn(`[Starfield] shader compile failed: ${gl.getShaderInfoLog(shader)}`);
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
	): StarProgram | null {
		const cached = programs.get(variantName);
		if (cached) return cached;

		const vertexSource = `#version 300 es
${prelude}
${define}
in vec2 a_pos;
in vec4 a_star;
uniform float u_starElevation;
uniform float u_time;
uniform float u_pixelRatio;
out float v_alpha;
out float v_temp;
void main() {
	vec4 p = projectTileWithElevation(a_pos, u_starElevation);
	/**
	 * Pin to just inside the far plane — the skybox trick.
	 *
	 * The camera far plane here is ~750 km (it shrinks with the close-up
	 * globe view), while the sky in frame is thousands of km away
	 * laterally: projected honestly, every star lands past far and the GPU
	 * clips it, silently, with no error. The old farZ guard only moved the
	 * shell nearer, which cannot help — distance, not height, is what
	 * exceeds far. Direction is all a star needs, so keep the projected
	 * x/y and trade z for far-minus-epsilon.
	 *
	 * Horizon occlusion still holds: a below-horizon star projects onto a
	 * ground pixel, and the opaque photograph drawn after this layer covers
	 * it. Sky pixels only ever receive above-horizon directions.
	 */
	gl_Position = vec4(p.xy, p.w * 0.99999, p.w);
	float tw = 0.72 + 0.28 * sin(u_time * (0.8 + fract(a_star.z * 0.159) * 1.4) + a_star.z);
	v_alpha = a_star.y * tw;
	v_temp = a_star.w;
	gl_PointSize = a_star.x * u_pixelRatio;
}`;
		const fragmentSource = `#version 300 es
precision highp float;
in float v_alpha;
in float v_temp;
uniform float u_night;
out highp vec4 fragColor;
// Blackbody tint (Tanner Helland approximation): blue-white Rigel reads
// ~12000 K, the Sun ~5778 K, ember Betelgeuse ~3600 K. t is temp/100,
// clamped to the 2500..30000 K the attribute guarantees.
vec3 starTint(float t) {
	t = clamp(t, 25.0, 300.0);
	float r = t <= 66.0 ? 1.0 : clamp(1.2929981 * pow(t - 60.0, -0.1332047), 0.0, 1.0);
	float g = t <= 66.0
		? clamp((99.470802 - 0.841123 * t + 0.000105 * t * t) / 255.0, 0.0, 1.0)
		: clamp(1.1298909 * pow(t - 60.0, -0.075514), 0.0, 1.0);
	float b = t >= 66.0 ? 1.0
		: t <= 19.0 ? 0.0
		: clamp((138.517731 - 9.111556 * t + 0.004413 * t * t) / 255.0, 0.0, 1.0);
	return vec3(r, g, b);
}
void main() {
	float d = length(gl_PointCoord - vec2(0.5));
	// Ordered edges: smoothstep with edge0 > edge1 is undefined behaviour
	// and evaluates to 0 on ANGLE/Metal, discarding every star silently.
	float a = (1.0 - smoothstep(0.12, 0.5, d)) * v_alpha * u_night;
	if (a < 0.004) discard;
	fragColor = vec4(starTint(v_temp / 100.0), a);
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
			console.warn(`[Starfield] program link failed: ${gl.getProgramInfoLog(program)}`);
			gl.deleteProgram(program);
			return null;
		}
		const uniform = (name: string) => gl.getUniformLocation(program, name);
		const entry: StarProgram = {
			program,
			loc: {
				u_projection_fallback_matrix: uniform('u_projection_fallback_matrix'),
				u_projection_matrix: uniform('u_projection_matrix'),
				u_projection_tile_mercator_coords: uniform('u_projection_tile_mercator_coords'),
				u_projection_clipping_plane: uniform('u_projection_clipping_plane'),
				u_projection_transition: uniform('u_projection_transition'),
				u_starElevation: uniform('u_starElevation'),
				u_time: uniform('u_time'),
				u_pixelRatio: uniform('u_pixelRatio'),
				u_night: uniform('u_night')
			},
			aPos: gl.getAttribLocation(program, 'a_pos'),
			aStar: gl.getAttribLocation(program, 'a_star')
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
				starBuffer = gl.createBuffer();
				if (!posBuffer || !starBuffer) {
					failOnce('could not allocate star buffers');
					return;
				}
				gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
				gl.bufferData(gl.ARRAY_BUFFER, posData, gl.STATIC_DRAW);
				gl.bindBuffer(gl.ARRAY_BUFFER, starBuffer);
				gl.bufferData(gl.ARRAY_BUFFER, starData, gl.STATIC_DRAW);
				gl.bindBuffer(gl.ARRAY_BUFFER, null);
			} catch (err) {
				failOnce(`onAdd threw: ${err instanceof Error ? err.message : String(err)}`);
			}
		},

		onRemove(_map: MlMap, gl: WebGL2RenderingContext) {
			for (const entry of programs.values()) gl.deleteProgram(entry.program);
			programs.clear();
			if (posBuffer) gl.deleteBuffer(posBuffer);
			if (starBuffer) gl.deleteBuffer(starBuffer);
			posBuffer = null;
			starBuffer = null;
			mapRef = null;
			failed = false;
			warned = false;
		},

		render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
			if (failed || !posBuffer || !starBuffer) return;
			// Day sky holds no stars and the draw is 8,404 points of nothing —
			// skip the program bind entirely. Read outside any tracking scope
			// (map RAF, not Svelte), so no dependency is created.
			const night = display.night;
			if (night <= 0.003) return;
			try {
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
				gl.uniform1f(prog.loc.u_time, performance.now() / 1000);
				const canvas = mapRef?.getCanvas() ?? null;
				const px =
					canvas && canvas.clientHeight > 0 ? gl.drawingBufferHeight / canvas.clientHeight : 1;
				gl.uniform1f(prog.loc.u_pixelRatio, px);
				gl.uniform1f(prog.loc.u_night, Math.min(1, night));

				gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
				gl.enableVertexAttribArray(prog.aPos);
				gl.vertexAttribPointer(prog.aPos, 2, gl.FLOAT, false, 0, 0);
				gl.bindBuffer(gl.ARRAY_BUFFER, starBuffer);
				gl.enableVertexAttribArray(prog.aStar);
				gl.vertexAttribPointer(prog.aStar, 4, gl.FLOAT, false, 0, 0);

				// Test against the terrain's depth, write none of our own:
				// later translucent layers must not trip over star-depth.
				gl.depthMask(false);
				// The painter leaves tile-clipping scissor/stencil state behind
				// and never resets it for custom layers: drawing under a stale
				// (often empty) scissor box clips every star with no error.
				// Save, clear, draw, restore — the painter's state cache must
				// still match reality for the layers after us.
				const scissorWas = gl.isEnabled(gl.SCISSOR_TEST);
				const stencilWas = gl.isEnabled(gl.STENCIL_TEST);
				gl.disable(gl.SCISSOR_TEST);
				gl.disable(gl.STENCIL_TEST);
				gl.enable(gl.BLEND);
				gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
				gl.drawArrays(gl.POINTS, 0, STAR_COUNT);
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

<!-- First in the style, before the `gibs` ground raster: translucent layers
     paint bottom-to-top, and the ground photograph must cover any star that
     depth missed. (Depth should miss nothing — this ordering is the belt.) -->
<CustomLayer id="night-stars" beforeId="gibs-day" {implementation} />
