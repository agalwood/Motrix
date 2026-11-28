import '@testing-library/jest-dom/vitest'
import { usePopupPositioning } from '@renderer/components/ui/popup-positioning'
import { act, render, screen } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WindowControlsOverlayProvider } from './window-controls-overlay-provider'

const mocks = vi.hoisted(() => ({
  platform: 'linux',
  on: vi.fn(),
  off: vi.fn(),
}))
vi.mock('@renderer/lib/transport', () => ({
  transport: {
    get platform() {
      return mocks.platform
    },
    on: mocks.on,
    off: mocks.off,
  },
}))

function PortalProbe() {
  const positioning = usePopupPositioning(8)
  return createPortal(
    <output data-testid="positioning">{JSON.stringify(positioning)}</output>,
    document.body
  )
}

class TestOverlay extends EventTarget {
  visible = true
  height = 54
  getTitlebarAreaRect() {
    return new DOMRect(0, 0, 600, this.height)
  }
}
let overlay: TestOverlay

beforeEach(() => {
  vi.clearAllMocks()
  mocks.platform = 'linux'
  overlay = new TestOverlay()
  Object.defineProperty(navigator, 'windowControlsOverlay', {
    value: overlay,
    configurable: true,
  })
})

describe('WindowControlsOverlayProvider', () => {
  it('protects portaled menus and releases the boundary in fullscreen', () => {
    const remove = vi.spyOn(overlay, 'removeEventListener')
    const { unmount } = render(
      <WindowControlsOverlayProvider>
        <PortalProbe />
      </WindowControlsOverlayProvider>
    )
    const read = () =>
      JSON.parse(screen.getByTestId('positioning').textContent ?? '{}')
    expect(read().collisionPadding.top).toBe(54)
    act(() => {
      overlay.visible = false
      overlay.dispatchEvent(new Event('geometrychange'))
    })
    expect(read()).toEqual({ collisionPadding: 8 })
    act(() => {
      overlay.visible = true
      overlay.dispatchEvent(new Event('geometrychange'))
    })
    expect(read().collisionPadding.top).toBe(54)
    unmount()
    expect(remove).toHaveBeenCalledWith('geometrychange', expect.any(Function))
    expect(mocks.on).not.toHaveBeenCalled()
  })

  it('reads fullscreen on mount without consuming WindowChrome IPC replay', () => {
    overlay.visible = false
    render(
      <WindowControlsOverlayProvider>
        <PortalProbe />
      </WindowControlsOverlayProvider>
    )
    expect(screen.getByTestId('positioning')).toHaveTextContent(
      '{"collisionPadding":8}'
    )
    expect(mocks.on).not.toHaveBeenCalled()
  })

  it('tracks native geometry in CSS pixels after a zoom or frame change', () => {
    render(
      <WindowControlsOverlayProvider>
        <PortalProbe />
      </WindowControlsOverlayProvider>
    )
    act(() => {
      overlay.height = 43
      overlay.dispatchEvent(new Event('geometrychange'))
    })
    expect(
      JSON.parse(screen.getByTestId('positioning').textContent ?? '{}')
        .collisionPadding.top
    ).toBe(43)
  })

  it.each(['darwin', 'win32', 'web'])(
    'keeps %s popups on their existing rules',
    (platform) => {
      mocks.platform = platform
      render(
        <WindowControlsOverlayProvider>
          <PortalProbe />
        </WindowControlsOverlayProvider>
      )
      expect(screen.getByTestId('positioning')).toHaveTextContent(
        '{"collisionPadding":8}'
      )
      expect(mocks.on).not.toHaveBeenCalled()
    }
  )
})
