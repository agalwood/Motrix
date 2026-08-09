import {
  FALLBACK_PALETTE,
  type GlassPalette,
  GRADIENT_PRESETS,
  type RgbColor,
} from './config'
import {
  CUBIC_GLASS_FRAGMENT_SHADER,
  CUBIC_GLASS_VERTEX_SHADER,
  MAX_GRADIENT_BLOBS,
  MAX_GRADIENT_ENVELOPES,
} from './shaders'
import type { CubicGlassGradientPreset } from './types'

interface ShaderUniforms {
  blobColor: WebGLUniformLocation
  blobGeometry: WebGLUniformLocation
  cell: WebGLUniformLocation
  envelopeGeometry: WebGLUniformLocation
  envelopeParams: WebGLUniformLocation
  glowOffset: WebGLUniformLocation
  lowerFalloff: WebGLUniformLocation
  resolution: WebGLUniformLocation
}

export interface CubicGlassSceneFrame {
  height: number
  offsetX: number
  offsetY: number
  preset: CubicGlassGradientPreset
  refreshScene: boolean
  width: number
}

export interface CubicGlassWebGlScene {
  dispose: (contextLost?: boolean) => void
  render: (frame: CubicGlassSceneFrame) => void
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null

  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, CUBIC_GLASS_VERTEX_SHADER)
  const fragment = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    CUBIC_GLASS_FRAGMENT_SHADER
  )
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex)
    if (fragment) gl.deleteShader(fragment)
    return null
  }

  const program = gl.createProgram()
  if (!program) {
    gl.deleteShader(vertex)
    gl.deleteShader(fragment)
    return null
  }

  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return null
  }
  return program
}

function getUniforms(
  gl: WebGL2RenderingContext,
  program: WebGLProgram
): ShaderUniforms | null {
  const locations = {
    resolution: gl.getUniformLocation(program, 'u_resolution'),
    glowOffset: gl.getUniformLocation(program, 'u_glow_offset'),
    cell: gl.getUniformLocation(program, 'u_cell'),
    lowerFalloff: gl.getUniformLocation(program, 'u_lower_falloff'),
    blobGeometry: gl.getUniformLocation(program, 'u_blob_geometry[0]'),
    blobColor: gl.getUniformLocation(program, 'u_blob_color[0]'),
    envelopeGeometry: gl.getUniformLocation(program, 'u_envelope_geometry[0]'),
    envelopeParams: gl.getUniformLocation(program, 'u_envelope_params[0]'),
  }
  if (Object.values(locations).some((location) => location === null)) {
    return null
  }
  return locations as ShaderUniforms
}

function readRgbToken(
  styles: CSSStyleDeclaration,
  token: string,
  fallback: RgbColor
): RgbColor {
  const channels = styles
    .getPropertyValue(token)
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (
    channels.length < 3 ||
    channels.slice(0, 3).some((channel) => !Number.isFinite(channel))
  ) {
    return fallback
  }
  const [red, green, blue] = channels
  if (red === undefined || green === undefined || blue === undefined) {
    return fallback
  }
  return [red / 255, green / 255, blue / 255]
}

function readPalette(canvas: HTMLCanvasElement): GlassPalette {
  const styles = getComputedStyle(canvas)
  return {
    cell: readRgbToken(styles, '--cubic-glass-cell-rgb', FALLBACK_PALETTE.cell),
    blue: readRgbToken(styles, '--cubic-glass-blue-rgb', FALLBACK_PALETTE.blue),
    cyan: readRgbToken(styles, '--cubic-glass-cyan-rgb', FALLBACK_PALETTE.cyan),
    violet: readRgbToken(
      styles,
      '--cubic-glass-violet-rgb',
      FALLBACK_PALETTE.violet
    ),
    pink: readRgbToken(styles, '--cubic-glass-pink-rgb', FALLBACK_PALETTE.pink),
    warm: readRgbToken(styles, '--cubic-glass-warm-rgb', FALLBACK_PALETTE.warm),
  }
}

function setColor(
  gl: WebGL2RenderingContext,
  location: WebGLUniformLocation,
  color: RgbColor
) {
  gl.uniform3f(location, color[0], color[1], color[2])
}

function setGradientPreset(
  gl: WebGL2RenderingContext,
  uniforms: ShaderUniforms,
  palette: GlassPalette,
  preset: CubicGlassGradientPreset
) {
  const geometry = new Float32Array(MAX_GRADIENT_BLOBS * 4)
  const colors = new Float32Array(MAX_GRADIENT_BLOBS * 4)
  const envelopeGeometry = new Float32Array(MAX_GRADIENT_ENVELOPES * 4)
  const envelopeParams = new Float32Array(MAX_GRADIENT_ENVELOPES * 4)

  const config = GRADIENT_PRESETS[preset]
  for (const [index, blob] of config.blobs.entries()) {
    const offset = index * 4
    const color = palette[blob.color]
    geometry.set([...blob.center, ...blob.radius], offset)
    colors.set([...color, blob.intensity], offset)
  }
  for (const [index, envelope] of config.envelopes.entries()) {
    envelopeGeometry.set([...envelope.center, ...envelope.radius], index * 4)
    envelopeParams.set(
      [
        envelope.lowerFalloff,
        envelope.intensity,
        envelope.lowerWidthScale,
        envelope.horizontalPower,
      ],
      index * 4
    )
  }

  gl.uniform4fv(uniforms.blobGeometry, geometry)
  gl.uniform4fv(uniforms.blobColor, colors)
  gl.uniform4fv(uniforms.envelopeGeometry, envelopeGeometry)
  gl.uniform4fv(uniforms.envelopeParams, envelopeParams)
  gl.uniform1f(uniforms.lowerFalloff, config.lowerFalloff)
}

export function createCubicGlassWebGlScene(
  canvas: HTMLCanvasElement
): CubicGlassWebGlScene | null {
  let context: WebGL2RenderingContext | null = null
  try {
    context = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      powerPreference: 'low-power',
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      stencil: false,
    })
  } catch {
    return null
  }
  if (!context) return null
  const gl = context

  const program = createProgram(gl)
  const vertexArray = gl.createVertexArray()
  if (!program || !vertexArray) {
    if (program) gl.deleteProgram(program)
    if (vertexArray) gl.deleteVertexArray(vertexArray)
    return null
  }

  const uniforms = getUniforms(gl, program)
  if (!uniforms) {
    gl.deleteVertexArray(vertexArray)
    gl.deleteProgram(program)
    return null
  }

  return {
    render({ height, offsetX, offsetY, preset, refreshScene, width }) {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }

      gl.viewport(0, 0, width, height)
      // Biome mistakes WebGL's useProgram() for a conditional React hook.
      // biome-ignore lint/correctness/useHookAtTopLevel: WebGL API, not a hook.
      gl.useProgram(program)
      gl.bindVertexArray(vertexArray)
      gl.uniform2f(uniforms.resolution, width, height)
      gl.uniform2f(uniforms.glowOffset, offsetX, offsetY)
      if (refreshScene) {
        const palette = readPalette(canvas)
        setColor(gl, uniforms.cell, palette.cell)
        setGradientPreset(gl, uniforms, palette, preset)
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    dispose(contextLost = false) {
      if (contextLost) return
      gl.deleteVertexArray(vertexArray)
      gl.deleteProgram(program)
    },
  }
}
