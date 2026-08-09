import { act, fireEvent, render, screen } from '@testing-library/react'
import { Profiler } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarqueeOverlay } from './marquee-overlay'

const CONTAINER_RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  bottom: 400,
  right: 800,
  width: 800,
  height: 400,
  toJSON: () => ({}),
} as DOMRect

let frameCallbacks: Map<number, FrameRequestCallback>
let nextFrameId: number
let requestAnimationFrameMock: ReturnType<typeof vi.fn>
let cancelAnimationFrameMock: ReturnType<typeof vi.fn>

function flushAnimationFrames(timestamp = 1000 / 60) {
  const callbacks = [...frameCallbacks.values()]
  frameCallbacks.clear()
  act(() => {
    for (const callback of callbacks) {
      callback(timestamp)
    }
  })
}

function createMockContainer() {
  const container = document.createElement('div')
  const getBoundingClientRect = vi.fn(() => CONTAINER_RECT)
  const scrollBy = vi.fn((_x: number, y: number) => {
    container.scrollTop += y
  })

  Object.defineProperty(container, 'getBoundingClientRect', {
    value: getBoundingClientRect,
  })
  Object.defineProperty(container, 'scrollBy', { value: scrollBy })
  Object.defineProperty(container, 'scrollTop', {
    value: 0,
    writable: true,
  })
  document.body.appendChild(container)

  return { container, getBoundingClientRect, scrollBy }
}

function renderOverlay(container: HTMLDivElement) {
  const onSelectionChange = vi.fn()
  const onSelectionEnd = vi.fn()
  const view = render(
    <MarqueeOverlay
      containerRef={{ current: container }}
      rowHeight={40}
      totalCount={100}
      onSelectionChange={onSelectionChange}
      onSelectionEnd={onSelectionEnd}
    />
  )

  return { ...view, onSelectionChange, onSelectionEnd }
}

beforeEach(() => {
  frameCallbacks = new Map()
  nextFrameId = 1
  requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
    const frameId = nextFrameId
    nextFrameId += 1
    frameCallbacks.set(frameId, callback)
    return frameId
  })
  cancelAnimationFrameMock = vi.fn((frameId: number) => {
    frameCallbacks.delete(frameId)
  })
  vi.stubGlobal('requestAnimationFrame', requestAnimationFrameMock)
  vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('MarqueeOverlay', () => {
  it('keeps one box node mounted and updates its transform imperatively', () => {
    const { container } = createMockContainer()
    renderOverlay(container)
    const initialBox = screen.getByTestId('marquee-box')

    expect(initialBox.style.opacity).toBe('0')
    expect(initialBox.style.transform).toContain('scale(0.001, 0.001)')
    expect(initialBox.style.willChange).toBe('')
    const overlay = initialBox.closest('svg')
    expect(overlay?.classList.contains('inset-0')).toBe(true)
    expect(overlay?.classList.contains('size-full')).toBe(true)

    fireEvent.mouseDown(container, { clientX: 100, clientY: 120 })
    fireEvent.mouseMove(window, { clientX: 140, clientY: 220 })
    flushAnimationFrames()

    const firstTransform = initialBox.style.transform
    expect(screen.getByTestId('marquee-box')).toBe(initialBox)
    expect(firstTransform).toContain('translate3d(100px, 120px, 0)')
    expect(initialBox.style.opacity).toBe('1')
    expect(initialBox.style.willChange).toBe('transform')

    fireEvent.mouseMove(window, { clientX: 180, clientY: 260 })
    flushAnimationFrames()

    expect(screen.getByTestId('marquee-box')).toBe(initialBox)
    expect(initialBox.style.transform).not.toBe(firstTransform)
  })

  it('updates drag geometry without a React update commit', () => {
    const { container } = createMockContainer()
    const onRender = vi.fn()

    render(
      <Profiler id="marquee-overlay" onRender={onRender}>
        <MarqueeOverlay
          containerRef={{ current: container }}
          rowHeight={40}
          totalCount={100}
          onSelectionChange={vi.fn()}
          onSelectionEnd={vi.fn()}
        />
      </Profiler>
    )
    expect(onRender).toHaveBeenCalledOnce()

    fireEvent.mouseDown(container, { clientX: 100, clientY: 120 })
    fireEvent.mouseMove(window, { clientX: 140, clientY: 220 })
    flushAnimationFrames()
    fireEvent.mouseMove(window, { clientX: 180, clientY: 260 })
    flushAnimationFrames()

    expect(onRender).toHaveBeenCalledOnce()
  })

  it('does not show the box or emit a range for a small movement', () => {
    const { container } = createMockContainer()
    const { onSelectionChange } = renderOverlay(container)

    fireEvent.mouseDown(container, { clientX: 100, clientY: 120 })
    fireEvent.mouseMove(window, { clientX: 102, clientY: 122 })
    fireEvent.mouseUp(window)

    expect(screen.getByTestId('marquee-box').style.opacity).toBe('0')
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('emits each active frame so the store can resolve live items', () => {
    const { container } = createMockContainer()
    const { onSelectionChange } = renderOverlay(container)

    fireEvent.mouseDown(container, { clientX: 100, clientY: 120 })
    fireEvent.mouseMove(window, { clientX: 140, clientY: 130 })
    flushAnimationFrames()
    fireEvent.mouseMove(window, { clientX: 160, clientY: 135 })
    flushAnimationFrames()

    expect(onSelectionChange).toHaveBeenCalledTimes(2)
    expect(onSelectionChange).toHaveBeenNthCalledWith(1, 3, 3)
    expect(onSelectionChange).toHaveBeenNthCalledWith(2, 3, 3)
  })

  it('reads the container rect once at drag start, not on each move', () => {
    const { container, getBoundingClientRect } = createMockContainer()
    renderOverlay(container)

    fireEvent.mouseDown(container, { clientX: 100, clientY: 120 })
    fireEvent.mouseMove(window, { clientX: 140, clientY: 180 })
    fireEvent.mouseMove(window, { clientX: 160, clientY: 220 })
    flushAnimationFrames()

    expect(getBoundingClientRect).toHaveBeenCalledOnce()
  })

  it('renders the final range, hides the box, and ends selection once', () => {
    const { container } = createMockContainer()
    const { onSelectionChange, onSelectionEnd } = renderOverlay(container)

    fireEvent.mouseDown(container, { clientX: 100, clientY: 120 })
    fireEvent.mouseMove(window, { clientX: 140, clientY: 220 })
    fireEvent.mouseUp(window)
    fireEvent.mouseUp(window)

    expect(onSelectionChange).toHaveBeenCalledWith(3, 5)
    expect(onSelectionEnd).toHaveBeenCalledOnce()
    expect(screen.getByTestId('marquee-box').style.opacity).toBe('0')
    expect(screen.getByTestId('marquee-box').style.transform).toContain(
      'scale(0.001, 0.001)'
    )
    expect(screen.getByTestId('marquee-box').style.willChange).toBe('')
  })

  it('cancels a queued frame on mouseup', () => {
    const { container } = createMockContainer()
    renderOverlay(container)

    fireEvent.mouseDown(container, { clientX: 100, clientY: 120 })
    fireEvent.mouseMove(window, { clientX: 140, clientY: 220 })
    expect(frameCallbacks.has(1)).toBe(true)

    fireEvent.mouseUp(window)

    expect(cancelAnimationFrameMock).toHaveBeenCalledWith(1)
    expect(frameCallbacks).toHaveLength(0)
  })

  it('does not advance auto-scroll while painting the final mouseup range', () => {
    const { container, scrollBy } = createMockContainer()
    renderOverlay(container)

    fireEvent.mouseDown(container, { clientX: 100, clientY: 200 })
    fireEvent.mouseMove(window, { clientX: 140, clientY: 390 })
    expect(frameCallbacks.has(1)).toBe(true)

    fireEvent.mouseUp(window)

    expect(scrollBy).not.toHaveBeenCalled()
  })

  it('cancels a queued frame on unmount', () => {
    const { container } = createMockContainer()
    const { unmount } = renderOverlay(container)

    fireEvent.mouseDown(container, { clientX: 100, clientY: 120 })
    fireEvent.mouseMove(window, { clientX: 140, clientY: 220 })
    expect(frameCallbacks.has(1)).toBe(true)

    unmount()

    expect(cancelAnimationFrameMock).toHaveBeenCalledWith(1)
    expect(frameCallbacks).toHaveLength(0)
  })

  it('does not respond when disabled', () => {
    const { container } = createMockContainer()
    const onSelectionChange = vi.fn()
    const onSelectionEnd = vi.fn()

    render(
      <MarqueeOverlay
        containerRef={{ current: container }}
        rowHeight={40}
        totalCount={100}
        enabled={false}
        onSelectionChange={onSelectionChange}
        onSelectionEnd={onSelectionEnd}
      />
    )

    fireEvent.mouseDown(container, { clientX: 100, clientY: 120 })
    fireEvent.mouseMove(window, { clientX: 140, clientY: 220 })
    fireEvent.mouseUp(window)

    expect(onSelectionChange).not.toHaveBeenCalled()
    expect(onSelectionEnd).not.toHaveBeenCalled()
  })
})
