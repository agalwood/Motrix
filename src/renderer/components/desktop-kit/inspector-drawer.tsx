import {
  Drawer,
  DrawerBody,
  DrawerHeader,
  DrawerPopup,
  DrawerPortal,
  DrawerTitle,
  DrawerViewport,
} from '@renderer/components/ui/drawer'
import { type ReactNode, useEffect, useRef, useState } from 'react'

export type InspectorSnap = 'compact' | 'medium' | 'expanded'
const SNAP_NAMES: InspectorSnap[] = ['compact', 'medium', 'expanded']

export function getInspectorSnapHeights(availableHeight: number) {
  const maximum = Math.max(
    1,
    Math.min(Math.round(availableHeight * 0.75), availableHeight - 64)
  )
  // Keep useful detents at least 48px apart in short windows. The semantic
  // preference survives merging, so resizing the window restores its intent.
  const compact = maximum - 220 < 48 ? maximum : 220
  let medium = Math.max(compact, Math.round(availableHeight * 0.5))
  if (medium - compact < 48) medium = compact
  if (maximum - medium < 48) medium = maximum
  return [compact, medium, maximum] as const
}

export function InspectorDrawer({
  container,
  open,
  snap,
  onSnapChange,
  onClose,
  title,
  resizeLabel,
  renderHeader,
  children,
}: {
  container: HTMLElement | null
  open: boolean
  snap: InspectorSnap
  onSnapChange: (snap: InspectorSnap) => void
  onClose: () => void
  title: string
  resizeLabel: string
  renderHeader: (resizeHandle: ReactNode) => ReactNode
  children: ReactNode
}) {
  const popupRef = useRef<HTMLDivElement>(null)
  const [availableHeight, setAvailableHeight] = useState(600)
  useEffect(() => {
    if (!container) return
    const measure = () => {
      const height = container.getBoundingClientRect().height
      if (height > 0) setAvailableHeight(height)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [container])
  const heights = getInspectorSnapHeights(availableHeight)
  const maximum = heights[2]
  const snapPoints = [...new Set(heights)]
  const height = heights[SNAP_NAMES.indexOf(snap)]
  const selectHeight = (point: number) => {
    if (point === height || !snapPoints.includes(point)) return
    onSnapChange(
      point === maximum ? 'expanded' : SNAP_NAMES[heights.indexOf(point)]
    )
  }
  if (!container) return null
  return (
    <Drawer
      open={open}
      modal={false}
      disablePointerDismissal
      swipeDirection="down"
      snapPoints={snapPoints}
      snapPoint={height}
      snapToSequentialPoints
      onSnapPointChange={(point) => {
        if (typeof point === 'number') selectHeight(point)
      }}
      onOpenChange={(next, details) => {
        if (next) return
        if (details.reason === 'escape-key') {
          const target = details.event.target
          if (
            !(target instanceof Node) ||
            !popupRef.current?.contains(target) ||
            (target instanceof Element &&
              target.closest('[data-activity-detail-surface="true"]'))
          ) {
            details.cancel()
            return
          }
        }
        onClose()
      }}
    >
      <DrawerPortal container={container}>
        <DrawerViewport className="pointer-events-none absolute inset-0 z-30 flex items-end overflow-hidden">
          <DrawerPopup
            ref={popupRef}
            initialFocus={false}
            finalFocus={() => {
              const active = container.ownerDocument.activeElement
              // Filtering can hide the inspector while the user is typing.
              // Preserve focus outside the drawer instead of stealing it.
              if (
                active &&
                active !== container.ownerDocument.body &&
                !popupRef.current?.contains(active)
              )
                return false
              return (
                container.querySelector<HTMLElement>('[data-downloads-grid]') ??
                container.querySelector<HTMLElement>(
                  '[data-slot="toolbar-button"]'
                )
              )
            }}
            aria-label={title}
            className="downloads-inspector-popup pointer-events-auto w-full shadow-[0_-3px_12px_rgba(15,23,42,0.08)]"
            style={{
              height: maximum,
              // Base UI registers these variables with inherits: false. Read
              // them on the popup itself, keeping its offscreen portion out
              // of the content's flex height at every snap and during swipes.
              paddingBottom:
                'max(0px, calc(var(--drawer-snap-point-offset, 0px) + var(--drawer-swipe-movement-y, 0px)))',
            }}
          >
            <div className="flex min-h-0 flex-1 flex-col">
              <DrawerTitle className="sr-only">{title}</DrawerTitle>
              <DrawerHeader
                className="shrink-0 cursor-ns-resize touch-none select-none gap-0 p-0 [&_button]:cursor-default"
                onPointerDown={(event) => {
                  if (
                    (event.target as Element).closest(
                      'button, a, input, select, textarea, [role="button"]'
                    )
                  )
                    event.stopPropagation()
                }}
                onTouchStart={(event) => {
                  if (
                    (event.target as Element).closest(
                      'button, a, input, select, textarea, [role="button"]'
                    )
                  )
                    event.stopPropagation()
                }}
              >
                {renderHeader(
                  // biome-ignore lint/a11y/useSemanticElements: The header's empty space is a keyboard-adjustable drawer resize control.
                  <div
                    role="separator"
                    tabIndex={0}
                    aria-orientation="horizontal"
                    aria-label={resizeLabel}
                    aria-valuemin={snapPoints[0]}
                    aria-valuemax={maximum}
                    aria-valuenow={height}
                    className="min-w-6 flex-1 self-stretch outline-none focus-visible:shadow-[inset_0_-1px_0_var(--ring)]"
                    onKeyDown={(event) => {
                      if (
                        !['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(
                          event.key
                        )
                      )
                        return
                      event.preventDefault()
                      event.stopPropagation()
                      if (event.key === 'Home') onSnapChange('compact')
                      else if (event.key === 'End') onSnapChange('expanded')
                      else {
                        const index = snapPoints.indexOf(height)
                        selectHeight(
                          snapPoints[
                            Math.max(
                              0,
                              Math.min(
                                snapPoints.length - 1,
                                index + (event.key === 'ArrowUp' ? 1 : -1)
                              )
                            )
                          ]
                        )
                      }
                    }}
                  />
                )}
              </DrawerHeader>
              <DrawerBody
                data-base-ui-swipe-ignore
                className="flex min-h-0 flex-1 flex-col"
              >
                {children}
              </DrawerBody>
            </div>
          </DrawerPopup>
        </DrawerViewport>
      </DrawerPortal>
    </Drawer>
  )
}
