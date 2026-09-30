import {
  getInspectorSnapHeights,
  type InspectorSnap,
  SNAP_NAMES,
} from '@renderer/components/desktop-kit/inspector-drawer'
import { TASK_HEADER_HEIGHT, TASK_ROW_HEIGHT } from './columns'

export interface InspectorInsetInput {
  /** Height of the portal container the drawer overlays (the page root). */
  pageHeight: number
  /** Height of the PanelShell footer, which the drawer also overlays. */
  footerHeight: number
  /** Height of the task grid wrapper that owns the scroll region. */
  gridHeight: number
  snap: InspectorSnap
  open: boolean
}

/**
 * Scroll space the task list must append below its last row while the
 * inspector drawer is open. The drawer floats over the page without resizing
 * the list, so without compensation the rows inside the covered band can
 * never scroll above the drawer's top edge. The overlaid footer needs no
 * reachability of its own, so only the overlap above it is compensated.
 */
export function resolveInspectorInset({
  pageHeight,
  footerHeight,
  gridHeight,
  snap,
  open,
}: InspectorInsetInput): number {
  if (!open || pageHeight <= 0) return 0
  const snapIndex = SNAP_NAMES.indexOf(snap)
  const drawerHeight =
    getInspectorSnapHeights(pageHeight)[
      snapIndex === -1 ? SNAP_NAMES.length - 1 : snapIndex
    ]
  const overlap = Math.max(0, drawerHeight - footerHeight)
  // A drawer tall enough to swallow nearly the whole grid must not push rows
  // out of reach in the other direction: cap the compensation so the last row
  // stays visible at the top of the scroll region.
  const limit = Math.max(0, gridHeight - TASK_HEADER_HEIGHT - TASK_ROW_HEIGHT)
  return Math.min(overlap, limit)
}
