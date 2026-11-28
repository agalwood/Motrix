import { PopupTopInsetContext } from '@renderer/components/ui/popup-positioning'
import { transport } from '@renderer/lib/transport'
import { WINDOW_CONTROLS_OVERLAY_HEIGHT } from '@shared/constants/window-chrome'
import { type ReactNode, useSyncExternalStore } from 'react'

interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean
  getTitlebarAreaRect(): DOMRect
}

function getOverlay() {
  return (
    navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay }
  ).windowControlsOverlay
}

function subscribe(listener: () => void) {
  const overlay = getOverlay()
  overlay?.addEventListener('geometrychange', listener)
  return () => overlay?.removeEventListener('geometrychange', listener)
}

function getSnapshot() {
  const overlay = getOverlay()
  if (!overlay) return WINDOW_CONTROLS_OVERLAY_HEIGHT
  if (!overlay.visible) return 0
  const rect = overlay.getTitlebarAreaRect()
  return Math.max(0, rect.y + rect.height)
}

function LinuxOverlayPopupBoundary({ children }: { children: ReactNode }) {
  // Read native geometry, including initial fullscreen/zoom state. Subscribing
  // again to the IPC replay channel would compete with WindowChrome's snapshot.
  const topInset = useSyncExternalStore(subscribe, getSnapshot)
  return (
    <PopupTopInsetContext.Provider value={topInset}>
      {children}
    </PopupTopInsetContext.Provider>
  )
}

export function WindowControlsOverlayProvider({
  children,
}: {
  children: ReactNode
}) {
  return __MOTRIX_TARGET__ === 'electron' && transport.platform === 'linux' ? (
    <LinuxOverlayPopupBoundary>{children}</LinuxOverlayPopupBoundary>
  ) : (
    children
  )
}
