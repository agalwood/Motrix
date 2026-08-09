import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type CubicGlassSceneFrame,
  createCubicGlassWebGlScene,
} from './webgl-scene'

function createFakeContext() {
  const vertexShader = {} as WebGLShader
  const fragmentShader = {} as WebGLShader
  const program = {} as WebGLProgram
  const vertexArray = {} as WebGLVertexArrayObject
  const context = {
    COMPILE_STATUS: 0x8b81,
    FRAGMENT_SHADER: 0x8b30,
    LINK_STATUS: 0x8b82,
    TRIANGLES: 0x0004,
    VERTEX_SHADER: 0x8b31,
    attachShader: vi.fn(),
    bindVertexArray: vi.fn(),
    compileShader: vi.fn(),
    createProgram: vi.fn(() => program),
    createShader: vi
      .fn()
      .mockReturnValueOnce(vertexShader)
      .mockReturnValueOnce(fragmentShader),
    createVertexArray: vi.fn(() => vertexArray),
    deleteProgram: vi.fn(),
    deleteShader: vi.fn(),
    deleteVertexArray: vi.fn(),
    drawArrays: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getShaderParameter: vi.fn(() => true),
    getUniformLocation: vi.fn(
      (_program: WebGLProgram, name: string) =>
        ({ name }) as unknown as WebGLUniformLocation
    ),
    linkProgram: vi.fn(),
    shaderSource: vi.fn(),
    uniform1f: vi.fn(),
    uniform2f: vi.fn(),
    uniform3f: vi.fn(),
    uniform4fv: vi.fn(),
    useProgram: vi.fn(),
    viewport: vi.fn(),
  }

  return {
    context,
    fragmentShader,
    program,
    vertexArray,
    vertexShader,
  }
}

const FRAME: CubicGlassSceneFrame = {
  height: 400,
  offsetX: 0.1,
  offsetY: -0.02,
  preset: 'blue-pink',
  refreshScene: true,
  width: 600,
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('cubic glass WebGL scene', () => {
  it('creates the low-power scene and separates scene uploads from motion frames', () => {
    const canvas = document.createElement('canvas')
    const { context, program, vertexArray } = createFakeContext()
    const getContext = vi
      .spyOn(canvas, 'getContext')
      .mockImplementation(() => context as unknown as WebGL2RenderingContext)

    const scene = createCubicGlassWebGlScene(canvas)
    expect(scene).not.toBeNull()
    expect(getContext).toHaveBeenCalledWith(
      'webgl2',
      expect.objectContaining({
        alpha: true,
        antialias: false,
        powerPreference: 'low-power',
        premultipliedAlpha: false,
      })
    )

    scene?.render(FRAME)
    expect(canvas.width).toBe(600)
    expect(canvas.height).toBe(400)
    expect(context.uniform4fv).toHaveBeenCalledTimes(4)
    expect(context.uniform3f).toHaveBeenCalledTimes(1)
    expect(context.uniform1f).toHaveBeenCalledTimes(1)
    expect(context.drawArrays).toHaveBeenLastCalledWith(context.TRIANGLES, 0, 3)

    scene?.render({ ...FRAME, offsetX: 0.2, refreshScene: false })
    expect(context.uniform4fv).toHaveBeenCalledTimes(4)
    expect(context.uniform3f).toHaveBeenCalledTimes(1)
    expect(context.uniform1f).toHaveBeenCalledTimes(1)
    expect(context.uniform2f).toHaveBeenLastCalledWith(
      expect.anything(),
      0.2,
      -0.02
    )

    scene?.dispose()
    expect(context.deleteVertexArray).toHaveBeenCalledWith(vertexArray)
    expect(context.deleteProgram).toHaveBeenCalledWith(program)
  })

  it('does not delete invalid resources after context loss', () => {
    const canvas = document.createElement('canvas')
    const { context } = createFakeContext()
    vi.spyOn(canvas, 'getContext').mockImplementation(
      () => context as unknown as WebGL2RenderingContext
    )

    const scene = createCubicGlassWebGlScene(canvas)
    scene?.dispose(true)

    expect(context.deleteVertexArray).not.toHaveBeenCalled()
    expect(context.deleteProgram).not.toHaveBeenCalled()
  })
})
