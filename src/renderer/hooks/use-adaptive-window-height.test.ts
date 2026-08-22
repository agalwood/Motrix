import { Commands } from '@shared/protocol/commands'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAdaptiveWindowHeight } from './use-adaptive-window-height'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn() },
}))

type ObserverCallback = (...args: any[]) => void

class MockResizeObserver {
  callback: ObserverCallback
  constructor(cb: ObserverCallback) {
    this.callback = cb
    MockResizeObserver.instances.push(this)
  }
  observe(_: Element) {}
  disconnect() {}
  trigger() {
    this.callback([], this as unknown as ResizeObserver)
  }
  static instances: MockResizeObserver[] = []
  static reset() {
    MockResizeObserver.instances = []
  }
}

class MockMutationObserver {
  callback: ObserverCallback
  constructor(cb: ObserverCallback) {
    this.callback = cb
    MockMutationObserver.instances.push(this)
  }
  observe(_: Node, _opts?: MutationObserverInit) {}
  disconnect() {}
  takeRecords(): MutationRecord[] {
    return []
  }
  trigger() {
    this.callback([], this as unknown as MutationObserver)
  }
  static instances: MockMutationObserver[] = []
  static reset() {
    MockMutationObserver.instances = []
  }
}

function mountContentElement(initialScrollHeight: number): {
  setScrollHeight: (n: number) => void
  cleanup: () => void
} {
  const el = document.createElement('div')
  el.setAttribute('data-adaptive-content', '')
  document.body.appendChild(el)
  let h = initialScrollHeight
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => h,
  })
  return {
    setScrollHeight: (n) => {
      h = n
    },
    cleanup: () => {
      document.body.removeChild(el)
    },
  }
}

describe('useAdaptiveWindowHeight', () => {
  beforeEach(async () => {
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    vi.stubGlobal('MutationObserver', MockMutationObserver)
    MockResizeObserver.reset()
    MockMutationObserver.reset()
    // Drive requestAnimationFrame synchronously for tests.
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
      cb(performance.now())
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    const mod = await import('@renderer/lib/transport')
    vi.mocked(mod.transport.invoke).mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not invoke when disabled', async () => {
    const { transport } = await import('@renderer/lib/transport')
    const { cleanup } = mountContentElement(500)
    renderHook(() =>
      useAdaptiveWindowHeight({
        width: 520,
        minHeight: 360,
        maxHeight: 760,
        enabled: false,
      })
    )
    expect(transport.invoke).not.toHaveBeenCalled()
    cleanup()
  })

  it('invokes ResizeWindow with content scrollHeight + chromeHeight', async () => {
    const { transport } = await import('@renderer/lib/transport')
    const { cleanup } = mountContentElement(500)
    renderHook(() =>
      useAdaptiveWindowHeight({
        width: 520,
        minHeight: 360,
        maxHeight: 760,
        chromeHeight: 0,
      })
    )
    expect(transport.invoke).toHaveBeenCalledWith(Commands.ResizeWindow, {
      width: 520,
      height: 500,
    })
    cleanup()
  })

  it('adds chromeHeight offset to measured scrollHeight', async () => {
    const { transport } = await import('@renderer/lib/transport')
    const { cleanup } = mountContentElement(500)
    renderHook(() =>
      useAdaptiveWindowHeight({
        width: 520,
        minHeight: 360,
        maxHeight: 760,
        chromeHeight: 40,
      })
    )
    expect(transport.invoke).toHaveBeenCalledWith(Commands.ResizeWindow, {
      width: 520,
      height: 540,
    })
    cleanup()
  })

  it('clamps to maxHeight when content exceeds', async () => {
    const { transport } = await import('@renderer/lib/transport')
    const { cleanup } = mountContentElement(1200)
    renderHook(() =>
      useAdaptiveWindowHeight({
        width: 520,
        minHeight: 360,
        maxHeight: 760,
        chromeHeight: 0,
      })
    )
    expect(transport.invoke).toHaveBeenCalledWith(Commands.ResizeWindow, {
      width: 520,
      height: 760,
    })
    cleanup()
  })

  it('clamps to minHeight when content is smaller', async () => {
    const { transport } = await import('@renderer/lib/transport')
    const { cleanup } = mountContentElement(100)
    renderHook(() =>
      useAdaptiveWindowHeight({
        width: 520,
        minHeight: 360,
        maxHeight: 760,
        chromeHeight: 0,
      })
    )
    expect(transport.invoke).toHaveBeenCalledWith(Commands.ResizeWindow, {
      width: 520,
      height: 360,
    })
    cleanup()
  })

  it('restores the smaller height after content expands and collapses', async () => {
    const { transport } = await import('@renderer/lib/transport')
    const { setScrollHeight, cleanup } = mountContentElement(400)
    renderHook(() =>
      useAdaptiveWindowHeight({
        width: 520,
        minHeight: 360,
        maxHeight: 760,
        chromeHeight: 0,
      })
    )
    expect(transport.invoke).toHaveBeenLastCalledWith(Commands.ResizeWindow, {
      width: 520,
      height: 400,
    })
    setScrollHeight(650)
    act(() => {
      MockResizeObserver.instances[0].trigger()
    })
    expect(transport.invoke).toHaveBeenLastCalledWith(Commands.ResizeWindow, {
      width: 520,
      height: 650,
    })
    setScrollHeight(320)
    act(() => {
      MockResizeObserver.instances[0].trigger()
    })
    expect(transport.invoke).toHaveBeenLastCalledWith(Commands.ResizeWindow, {
      width: 520,
      height: 360,
    })
    cleanup()
  })

  it('skips sub-2px deltas to avoid feedback loops', async () => {
    const { transport } = await import('@renderer/lib/transport')
    const { setScrollHeight, cleanup } = mountContentElement(500)
    renderHook(() =>
      useAdaptiveWindowHeight({
        width: 520,
        minHeight: 360,
        maxHeight: 760,
        chromeHeight: 0,
      })
    )
    expect(transport.invoke).toHaveBeenCalledTimes(1)
    setScrollHeight(501)
    act(() => {
      MockResizeObserver.instances[0].trigger()
    })
    expect(transport.invoke).toHaveBeenCalledTimes(1)
    setScrollHeight(520)
    act(() => {
      MockResizeObserver.instances[0].trigger()
    })
    expect(transport.invoke).toHaveBeenCalledTimes(2)
    cleanup()
  })
})
