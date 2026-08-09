import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sceneMock = vi.hoisted(() => ({
  create: vi.fn(),
  dispose: vi.fn(),
  render: vi.fn(),
}))

vi.mock('./webgl-scene', () => ({
  createCubicGlassWebGlScene: sceneMock.create,
}))

import { DEFAULT_CUBIC_GLASS_EFFECTS } from './config'
import { startCubicGlassRenderer } from './renderer'

function pointerMove(clientX: number, clientY: number) {
  const event = new Event('pointermove') as PointerEvent
  Object.defineProperties(event, {
    clientX: { value: clientX },
    clientY: { value: clientY },
    pointerType: { value: 'mouse' },
  })
  window.dispatchEvent(event)
}

describe('cubic glass renderer', () => {
  let nextFrameId = 0
  let frameCallbacks: Map<number, FrameRequestCallback>

  beforeEach(() => {
    frameCallbacks = new Map()
    nextFrameId = 0
    sceneMock.create.mockReturnValue({
      dispose: sceneMock.dispose,
      render: sceneMock.render,
    })
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        nextFrameId += 1
        frameCallbacks.set(nextFrameId, callback)
        return nextFrameId
      })
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((frameId: number) => frameCallbacks.delete(frameId))
    )
    vi.stubGlobal(
      'ResizeObserver',
      class {
        disconnect() {}
        observe() {}
        unobserve() {}
      }
    )
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: query.includes('(hover: hover)'),
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      }))
    )
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(2)
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function flushFrame(timestamp: number) {
    const next = frameCallbacks.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined
    if (!next) return false
    const [frameId, callback] = next
    frameCallbacks.delete(frameId)
    callback(timestamp)
    return true
  }

  it('coalesces pointer work and ends motion on a high-resolution frame', () => {
    const root = document.createElement('div')
    const canvas = document.createElement('canvas')
    root.append(canvas)
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      bottom: 1000,
      height: 1000,
      left: 0,
      right: 1600,
      top: 0,
      width: 1600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    })
    const effects = { ...DEFAULT_CUBIC_GLASS_EFFECTS, horizontalSpeed: 100 }

    const renderer = startCubicGlassRenderer(
      canvas,
      root,
      () => 'blue-pink',
      () => effects,
      () => root
    )

    expect(frameCallbacks.size).toBe(1)
    flushFrame(16)
    expect(sceneMock.render).toHaveBeenLastCalledWith(
      expect.objectContaining({ refreshScene: true })
    )
    expect(frameCallbacks.size).toBe(0)

    pointerMove(-10, 500)
    expect(frameCallbacks.size).toBe(0)

    pointerMove(1500, 500)
    pointerMove(1450, 500)
    expect(frameCallbacks.size).toBe(1)
    flushFrame(32)
    const firstMovingFrame = sceneMock.render.mock.lastCall?.[0]
    expect(firstMovingFrame).toEqual(
      expect.objectContaining({ refreshScene: false })
    )

    let timestamp = 32
    let renderedFrames = 1
    while (frameCallbacks.size > 0 && renderedFrames < 400) {
      timestamp += 1000 / 60
      flushFrame(timestamp)
      renderedFrames += 1
    }

    expect(renderedFrames).toBeLessThan(400)
    expect(frameCallbacks.size).toBe(0)
    const settledFrame = sceneMock.render.mock.lastCall?.[0]
    expect(settledFrame.width).toBeGreaterThan(firstMovingFrame.width)
    expect(settledFrame.height).toBeGreaterThan(firstMovingFrame.height)

    renderer.dispose()
    expect(sceneMock.dispose).toHaveBeenCalledWith(false)
  })
})
