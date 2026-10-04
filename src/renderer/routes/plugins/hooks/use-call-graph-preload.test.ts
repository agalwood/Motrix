import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCallGraphPreload } from './use-call-graph-preload'

const state = vi.hoisted(() => ({ kind: 'electron', preload: vi.fn() }))
vi.mock('@renderer/platform/services', () => ({
  usePlatformServices: () => ({ kind: state.kind }),
}))
vi.mock('../lib/call-graph-layout', () => ({
  preloadCallGraphLayout: state.preload,
}))

describe('desktop diagnostics preloading', () => {
  let idle: () => void
  const schedule = vi.fn((callback: () => void) => {
    idle = callback
    return 42
  })
  const cancel = vi.fn()
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    state.kind = 'electron'
    vi.stubGlobal('requestIdleCallback', schedule)
    vi.stubGlobal('cancelIdleCallback', cancel)
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('waits for the page to paint and then for an idle opportunity', () => {
    const { unmount } = renderHook(useCallGraphPreload)
    act(() => vi.advanceTimersByTime(199))
    expect(schedule).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1))
    expect(state.preload).not.toHaveBeenCalled()
    act(() => idle())
    expect(state.preload).toHaveBeenCalledOnce()
    unmount()
  })

  it('cancels both stages when navigating away', () => {
    const first = renderHook(useCallGraphPreload)
    first.unmount()
    act(() => vi.advanceTimersByTime(200))
    expect(schedule).not.toHaveBeenCalled()
    const second = renderHook(useCallGraphPreload)
    act(() => vi.advanceTimersByTime(200))
    second.unmount()
    expect(cancel).toHaveBeenCalledWith(42)
    expect(state.preload).not.toHaveBeenCalled()
  })

  it('starts immediately on intent while skipping hidden windows', () => {
    const { result, unmount } = renderHook(useCallGraphPreload)
    act(() => result.current())
    expect(state.preload).toHaveBeenCalledOnce()
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => vi.advanceTimersByTime(200))
    act(() => {
      idle()
      result.current()
    })
    expect(state.preload).toHaveBeenCalledOnce()
    unmount()
  })

  it('does not speculate in web clients', () => {
    state.kind = 'web'
    const { result, unmount } = renderHook(useCallGraphPreload)
    act(() => {
      result.current()
      vi.advanceTimersByTime(2000)
    })
    expect(schedule).not.toHaveBeenCalled()
    expect(state.preload).not.toHaveBeenCalled()
    unmount()
  })
})
