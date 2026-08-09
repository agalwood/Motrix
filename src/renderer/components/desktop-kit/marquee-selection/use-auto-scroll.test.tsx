import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useAutoScroll } from './use-auto-scroll'

const FRAME_DURATION_MS = 1000 / 60
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

function setupHook() {
  const container = document.createElement('div')
  const scrollBy = vi.fn()
  Object.defineProperty(container, 'scrollBy', { value: scrollBy })
  const containerRef = { current: container }
  const hook = renderHook(() =>
    useAutoScroll({
      containerRef,
      gutter: 100,
      maxSpeed: 15,
      enabled: true,
    })
  )

  return { ...hook, scrollBy }
}

describe('useAutoScroll', () => {
  it('stores pointer speed without scrolling until step runs', () => {
    const { result, scrollBy } = setupHook()

    act(() => result.current.updatePointer(390, CONTAINER_RECT))
    expect(scrollBy).not.toHaveBeenCalled()

    let shouldContinue = false
    act(() => {
      shouldContinue = result.current.step(0)
    })

    expect(shouldContinue).toBe(true)
    expect(scrollBy).toHaveBeenCalledOnce()
    expect(scrollBy).toHaveBeenCalledWith(0, 14)
  })

  it('normalizes each scroll step by elapsed frame time', () => {
    const { result, scrollBy } = setupHook()
    act(() => result.current.updatePointer(390, CONTAINER_RECT))

    act(() => {
      result.current.step(0)
      result.current.step(FRAME_DURATION_MS / 2)
      result.current.step(FRAME_DURATION_MS * 2.5)
    })

    expect(scrollBy).toHaveBeenNthCalledWith(1, 0, 14)
    expect(scrollBy).toHaveBeenNthCalledWith(2, 0, 7)
    expect(scrollBy).toHaveBeenNthCalledWith(3, 0, 28)
  })

  it('stops the loop when pointer speed becomes zero', () => {
    const { result, scrollBy } = setupHook()
    act(() => {
      result.current.updatePointer(390, CONTAINER_RECT)
      result.current.step(0)
      result.current.updatePointer(200, CONTAINER_RECT)
    })

    let shouldContinue = true
    act(() => {
      shouldContinue = result.current.step(FRAME_DURATION_MS)
    })

    expect(shouldContinue).toBe(false)
    expect(scrollBy).toHaveBeenCalledOnce()
  })

  it('resets elapsed time when stopped before a later gesture', () => {
    const { result, scrollBy } = setupHook()
    act(() => {
      result.current.updatePointer(390, CONTAINER_RECT)
      result.current.step(0)
      result.current.step(FRAME_DURATION_MS)
      result.current.stop()
      result.current.updatePointer(390, CONTAINER_RECT)
      result.current.step(1000)
    })

    expect(scrollBy).toHaveBeenNthCalledWith(1, 0, 14)
    expect(scrollBy).toHaveBeenNthCalledWith(2, 0, 14)
    expect(scrollBy).toHaveBeenNthCalledWith(3, 0, 14)
  })

  it('returns stable callbacks across rerenders', () => {
    const { result, rerender } = setupHook()
    const first = result.current

    rerender()

    expect(result.current.updatePointer).toBe(first.updatePointer)
    expect(result.current.step).toBe(first.step)
    expect(result.current.stop).toBe(first.stop)
  })
})
