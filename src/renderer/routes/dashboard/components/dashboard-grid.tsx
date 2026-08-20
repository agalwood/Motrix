import { useCompactHeader } from '@renderer/components/desktop-kit/hooks/use-compact-header'
import {
  COMPACT_ACTION_CLASS,
  HeaderActionButton,
} from '@renderer/components/desktop-kit/panel/header-action-button'
import { Button } from '@renderer/components/ui/button'
import { ButtonGroup } from '@renderer/components/ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import {
  DASHBOARD_COLUMNS,
  DASHBOARD_ROWS,
} from '@shared/schemas/dashboard-layout'
import type {
  DashboardLayoutSettings,
  DashboardTileHeight,
  DashboardTileId,
  DashboardTileLayout,
  DashboardTileSpan,
  DashboardTileWidth,
} from '@shared/types/settings'
import {
  Check,
  LayoutTemplate,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Undo2,
  X,
} from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  type DashboardLayoutFailureReason,
  getDashboardTileSizeOptions,
  maxTileBottom,
  moveTile,
  normalizeDashboardLayout,
  resizeTile,
  setTileEnabled,
} from '../layout/dashboard-layout'
import {
  applyDashboardPreset,
  DASHBOARD_LAYOUT_PRESETS,
  type DashboardLayoutPresetId,
  matchDashboardPreset,
} from '../layout/dashboard-presets'
import {
  type DashboardTileViewport,
  dashboardTileSizeLabel,
  dashboardTileSpanKey,
  dashboardTileViewport,
  getDashboardTileDefinition,
  nearestDashboardTilePresentation,
} from '../layout/dashboard-registry'
import {
  DashboardResizeGhost,
  type DashboardResizeGhostViewportRect,
} from './dashboard-resize-ghost'
import { DashboardTileFrame } from './dashboard-tile-frame'

const GRID_ROW_HEIGHT_PX = 128
const DASHBOARD_LAYOUT_MIN_WIDTH_PX = 560
const DASHBOARD_GUIDE_MIN_ROWS = 3
const DRAG_LERP_FACTOR = 0.22
const DRAG_SETTLE_EPSILON_PX = 0.5
// Stable identity outside configure mode so memos depending on hiddenTiles
// don't recompute when there is nothing hidden.
const NO_HIDDEN_TILES: DashboardTileLayout[] = []

interface HiddenTileOption {
  tile: DashboardTileLayout
  available: boolean
  failureReason?: DashboardLayoutFailureReason
}

interface DragGridMetrics {
  rect: DOMRect
  columnTracks: number[]
  rowTracks: number[]
  columnGap: number
  rowGap: number
  contentLeft: number
  contentTop: number
}

interface DashboardInteractionVisual {
  element: HTMLElement
  rect: DOMRect
  currentX: number
  currentY: number
  targetX: number
  targetY: number
}

interface DashboardInteractionSessionBase {
  id: DashboardTileId
  pointerId: number
  pointerX: number
  pointerY: number
  baseTiles: DashboardTileLayout[]
  previewTiles: DashboardTileLayout[]
  visuals: Map<DashboardTileId, DashboardInteractionVisual>
  rafId: number | null
  gridPreviousTouchAction: string
  bodyClassName: string | null
  releasePointerCapture: () => void
}

interface DashboardMoveSession extends DashboardInteractionSessionBase {
  kind: 'move'
  startPointerX: number
  startPointerY: number
}

interface DashboardResizeSession extends DashboardInteractionSessionBase {
  kind: 'resize'
  originTile: DashboardTileLayout
  previewSpan: DashboardTileSpan
  valid: boolean
  failureReason?: DashboardLayoutFailureReason
  reducedMotion: boolean
}

type DashboardInteractionSession = DashboardMoveSession | DashboardResizeSession

interface DashboardResizePreview {
  id: DashboardTileId
  geometry: Pick<DashboardTileLayout, 'x' | 'y' | 'w' | 'h'>
  viewportRect: DashboardResizeGhostViewportRect
  valid: boolean
  failureReason?: DashboardLayoutFailureReason
}

interface DashboardInteractionSetup {
  visuals: Map<DashboardTileId, DashboardInteractionVisual>
  gridPreviousTouchAction: string
  bodyClassName: string | null
  releasePointerCapture: () => void
}

function toPx(value: string): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Resolved `grid-template-*` is a px list ("301px 301px …") in browsers;
 *  anything unresolved (jsdom) yields [] so callers can fall back. */
function parseTrackList(value: string): number[] {
  if (!value) return []
  const tracks = value.split(' ').map((token) => Number.parseFloat(token))
  return tracks.length > 0 &&
    tracks.every((size) => Number.isFinite(size) && size >= 0)
    ? tracks
    : []
}

function trackIndexAt(tracks: number[], gap: number, offset: number): number {
  let end = 0
  for (let index = 0; index < tracks.length; index += 1) {
    end += (tracks[index] ?? 0) + (index < tracks.length - 1 ? gap : 0)
    if (offset < end) return index
  }
  return Math.max(0, tracks.length - 1)
}

function unboundedTrackIndexAt(
  tracks: number[],
  gap: number,
  offset: number,
  fallbackSize: number
): number {
  if (tracks.length === 0) {
    return Math.floor(offset / Math.max(1, fallbackSize))
  }

  let end = 0
  for (let index = 0; index < tracks.length; index += 1) {
    end +=
      (tracks[index] ?? fallbackSize) + (index < tracks.length - 1 ? gap : 0)
    if (offset < end) return index
  }

  const extrapolatedSize = (tracks.at(-1) ?? fallbackSize) + Math.max(0, gap)
  return (
    tracks.length + Math.floor((offset - end) / Math.max(1, extrapolatedSize))
  )
}

function trackOffsetAt(
  tracks: number[],
  gap: number,
  index: number,
  fallbackSize: number
): number {
  let offset = 0
  for (let i = 0; i < index; i += 1) {
    offset += (tracks[i] ?? fallbackSize) + gap
  }
  return offset
}

function trackSpanSize(
  tracks: number[],
  gap: number,
  start: number,
  span: number,
  fallbackSize: number
): number {
  const extrapolatedSize = tracks.at(-1) ?? fallbackSize
  let size = 0
  for (let index = start; index < start + span; index += 1) {
    size += tracks[index] ?? extrapolatedSize
    if (index < start + span - 1) size += gap
  }
  return size
}

function readDragGridMetrics(grid: HTMLElement): DragGridMetrics | null {
  const rect = grid.getBoundingClientRect()
  if (rect.width <= 0) return null

  const style = window.getComputedStyle(grid)
  const borderLeft = toPx(style.borderLeftWidth)
  const borderTop = toPx(style.borderTopWidth)
  const paddingLeft = toPx(style.paddingLeft)
  const paddingTop = toPx(style.paddingTop)

  return {
    rect,
    columnTracks: parseTrackList(style.gridTemplateColumns),
    rowTracks: parseTrackList(style.gridTemplateRows),
    columnGap: toPx(style.columnGap),
    rowGap: toPx(style.rowGap),
    contentLeft: rect.left + borderLeft + paddingLeft,
    contentTop: rect.top + borderTop + paddingTop,
  }
}

function cellFromPointer(
  metrics: DragGridMetrics,
  clientX: number,
  clientY: number
): { x: number; y: number } {
  const offsetX = clientX - metrics.contentLeft
  const offsetY = clientY - metrics.contentTop
  const x = Math.max(
    0,
    Math.min(
      DASHBOARD_COLUMNS - 1,
      metrics.columnTracks.length > 0
        ? trackIndexAt(metrics.columnTracks, metrics.columnGap, offsetX)
        : Math.floor(offsetX / (metrics.rect.width / DASHBOARD_COLUMNS))
    )
  )
  const y = Math.max(
    0,
    metrics.rowTracks.length > 0
      ? trackIndexAt(metrics.rowTracks, metrics.rowGap, offsetY)
      : Math.floor(offsetY / GRID_ROW_HEIGHT_PX)
  )

  return { x, y }
}

function rawResizeSpanFromPointer(
  metrics: DragGridMetrics,
  originTile: Pick<DashboardTileLayout, 'x' | 'y'>,
  clientX: number,
  clientY: number
): DashboardTileSpan {
  const offsetX = clientX - metrics.contentLeft
  const offsetY = clientY - metrics.contentTop
  const fallbackColumnWidth =
    metrics.columnTracks[0] ??
    metrics.rect.width / Math.max(1, DASHBOARD_COLUMNS)
  const fallbackRowHeight = metrics.rowTracks[0] ?? GRID_ROW_HEIGHT_PX
  const bottomRightX = unboundedTrackIndexAt(
    metrics.columnTracks,
    metrics.columnGap,
    offsetX,
    fallbackColumnWidth
  )
  const bottomRightY = unboundedTrackIndexAt(
    metrics.rowTracks,
    metrics.rowGap,
    offsetY,
    fallbackRowHeight
  )

  return {
    w: Math.min(
      DASHBOARD_COLUMNS,
      Math.max(1, bottomRightX - originTile.x + 1)
    ) as DashboardTileWidth,
    h: Math.min(
      DASHBOARD_ROWS,
      Math.max(1, bottomRightY - originTile.y + 1)
    ) as DashboardTileHeight,
  }
}

function tileCellOffset(
  metrics: DragGridMetrics,
  tile: Pick<DashboardTileLayout, 'x' | 'y'>
): { left: number; top: number } {
  const fallbackColumnWidth =
    metrics.columnTracks[0] ??
    metrics.rect.width / Math.max(1, DASHBOARD_COLUMNS)
  const fallbackRowHeight = metrics.rowTracks[0] ?? GRID_ROW_HEIGHT_PX

  return {
    left:
      metrics.contentLeft +
      trackOffsetAt(
        metrics.columnTracks,
        metrics.columnGap,
        tile.x,
        fallbackColumnWidth
      ),
    top:
      metrics.contentTop +
      trackOffsetAt(
        metrics.rowTracks,
        metrics.rowGap,
        tile.y,
        fallbackRowHeight
      ),
  }
}

function resizeGhostViewportRect(
  metrics: DragGridMetrics,
  geometry: Pick<DashboardTileLayout, 'x' | 'y' | 'w' | 'h'>
): DashboardResizeGhostViewportRect {
  const fallbackColumnWidth =
    metrics.columnTracks[0] ??
    metrics.rect.width / Math.max(1, DASHBOARD_COLUMNS)
  const fallbackRowHeight = metrics.rowTracks[0] ?? GRID_ROW_HEIGHT_PX

  return {
    left:
      metrics.contentLeft +
      trackOffsetAt(
        metrics.columnTracks,
        metrics.columnGap,
        geometry.x,
        fallbackColumnWidth
      ),
    top:
      metrics.contentTop +
      trackOffsetAt(
        metrics.rowTracks,
        metrics.rowGap,
        geometry.y,
        fallbackRowHeight
      ),
    width: trackSpanSize(
      metrics.columnTracks,
      metrics.columnGap,
      geometry.x,
      geometry.w,
      fallbackColumnWidth
    ),
    height: trackSpanSize(
      metrics.rowTracks,
      metrics.rowGap,
      geometry.y,
      geometry.h,
      fallbackRowHeight
    ),
  }
}

function findTileElement(
  grid: HTMLElement,
  id: DashboardTileId
): HTMLElement | null {
  return grid.querySelector<HTMLElement>(`[data-dashboard-tile-id="${id}"]`)
}

function matchesInteractionPointer(
  event: PointerEvent,
  session: DashboardInteractionSession
): boolean {
  return event.pointerId === session.pointerId || event.pointerId === 0
}

function recordInteractionPointer(
  event: PointerEvent,
  session: DashboardInteractionSession
): void {
  if (
    !event.isTrusted &&
    event.clientX === 0 &&
    event.clientY === 0 &&
    (session.pointerX !== 0 || session.pointerY !== 0)
  ) {
    return
  }
  session.pointerX = event.clientX
  session.pointerY = event.clientY
}

function isPrimaryPointerStart(
  event: React.PointerEvent<HTMLButtonElement>
): boolean {
  // jsdom's PointerEvent shim reports an empty pointerType and isPrimary=false
  // for otherwise-primary test input. Real browser pointer events always name
  // their pointer type, so only reject isPrimary=false when that signal exists.
  const pointerType = (event as { pointerType?: string }).pointerType
  return (
    event.button === 0 &&
    (event.isPrimary !== false ||
      pointerType === '' ||
      pointerType === undefined)
  )
}

function moveTargetFromPointer(
  metrics: DragGridMetrics,
  session: DashboardMoveSession
): { x: number; y: number } {
  const source = session.visuals.get(session.id)
  if (!source) {
    return cellFromPointer(metrics, session.pointerX, session.pointerY)
  }

  return cellFromPointer(
    metrics,
    source.rect.left + session.pointerX - session.startPointerX,
    source.rect.top + session.pointerY - session.startPointerY
  )
}

function captureInteractionVisuals(
  grid: HTMLElement,
  tiles: readonly DashboardTileLayout[]
): Map<DashboardTileId, DashboardInteractionVisual> {
  const visuals = new Map<DashboardTileId, DashboardInteractionVisual>()
  for (const tile of tiles) {
    if (!tile.enabled) continue
    const element = findTileElement(grid, tile.id)
    if (!element) continue
    visuals.set(tile.id, {
      element,
      rect: element.getBoundingClientRect(),
      currentX: 0,
      currentY: 0,
      targetX: 0,
      targetY: 0,
    })
    element.style.transition = 'none'
    element.style.willChange = 'transform'
  }
  return visuals
}

function setupInteractionLifecycle({
  grid,
  tiles,
  activeElement,
  pointerTarget,
  pointerId,
  bodyClassName,
  elevateActiveElement = true,
}: {
  grid: HTMLElement
  tiles: readonly DashboardTileLayout[]
  activeElement: HTMLElement
  pointerTarget: HTMLElement
  pointerId: number
  bodyClassName?: string
  elevateActiveElement?: boolean
}): DashboardInteractionSetup {
  let pointerCaptured = false
  try {
    if (pointerTarget.setPointerCapture) {
      pointerTarget.setPointerCapture(pointerId)
      pointerCaptured = true
    }
  } catch {
    // Continue with window-level listeners when capture is unavailable.
  }

  const visuals = captureInteractionVisuals(grid, tiles)
  if (elevateActiveElement) {
    activeElement.style.pointerEvents = 'none'
    activeElement.style.zIndex = '50'
  }
  if (bodyClassName) document.body.classList.add(bodyClassName)

  const releasePointerCapture = () => {
    if (!pointerCaptured) return
    try {
      pointerTarget.releasePointerCapture?.(pointerId)
    } catch {
      // Pointer capture may already be gone after pointercancel.
    } finally {
      pointerCaptured = false
    }
  }

  const gridPreviousTouchAction = grid.style.touchAction
  grid.style.touchAction = 'none'
  return {
    visuals,
    gridPreviousTouchAction,
    bodyClassName: bodyClassName ?? null,
    releasePointerCapture,
  }
}

function scheduleInteractionFrame(
  session: DashboardInteractionSession,
  renderFrame: FrameRequestCallback
): void {
  if (session.rafId !== null) return
  session.rafId = requestAnimationFrame(renderFrame)
}

function listenForInteractionPointer(
  session: DashboardInteractionSession,
  scheduleFrame: () => void,
  finish: () => void,
  cancel: () => void
): () => void {
  const handlePointerMove = (event: PointerEvent) => {
    if (!matchesInteractionPointer(event, session)) return
    recordInteractionPointer(event, session)
    scheduleFrame()
  }
  const handlePointerUp = (event: PointerEvent) => {
    if (!matchesInteractionPointer(event, session)) return
    recordInteractionPointer(event, session)
    scheduleFrame()
    finish()
  }
  const handlePointerCancel = (event: PointerEvent) => {
    if (!matchesInteractionPointer(event, session)) return
    cancel()
  }
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    cancel()
  }
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', handlePointerUp)
  window.addEventListener('pointercancel', handlePointerCancel)
  window.addEventListener('keydown', handleKeyDown)

  return () => {
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerUp)
    window.removeEventListener('pointercancel', handlePointerCancel)
    window.removeEventListener('keydown', handleKeyDown)
  }
}

function cleanupInteractionLifecycle(
  session: DashboardInteractionSession,
  grid: HTMLElement | null
): void {
  if (session.rafId !== null) {
    cancelAnimationFrame(session.rafId)
    session.rafId = null
  }
  const transitionRestoreElements: HTMLElement[] = []
  for (const visual of session.visuals.values()) {
    visual.element.style.transform = ''
    visual.element.style.willChange = ''
    visual.element.style.pointerEvents = ''
    visual.element.style.zIndex = ''
    transitionRestoreElements.push(visual.element)
  }
  requestAnimationFrame(() => {
    for (const element of transitionRestoreElements) {
      element.style.transition = ''
    }
  })
  if (grid) grid.style.touchAction = session.gridPreviousTouchAction
  if (session.bodyClassName) {
    document.body.classList.remove(session.bodyClassName)
  }
  session.releasePointerCapture()
}

function evaluateResizeSession(
  session: DashboardResizeSession,
  metrics: DragGridMetrics
): void {
  const rawSpan = rawResizeSpanFromPointer(
    metrics,
    session.originTile,
    session.pointerX,
    session.pointerY
  )
  const presentation = nearestDashboardTilePresentation(session.id, rawSpan)
  const result = resizeTile(session.baseTiles, session.id, presentation.span)

  session.previewSpan = { ...presentation.span }
  session.valid = result.ok
  session.previewTiles = result.ok ? result.tiles : session.baseTiles
  session.failureReason = result.ok ? undefined : result.reason
}

function sameResizePreview(
  current: DashboardResizePreview | null,
  next: DashboardResizePreview
): boolean {
  return (
    current?.id === next.id &&
    current.geometry.x === next.geometry.x &&
    current.geometry.y === next.geometry.y &&
    dashboardTileSpanKey(current.geometry) ===
      dashboardTileSpanKey(next.geometry) &&
    current.viewportRect.left === next.viewportRect.left &&
    current.viewportRect.top === next.viewportRect.top &&
    current.viewportRect.width === next.viewportRect.width &&
    current.viewportRect.height === next.viewportRect.height &&
    current.valid === next.valid &&
    current.failureReason === next.failureReason
  )
}

export interface DashboardGridProps {
  layout: DashboardLayoutSettings
  configureDisabled?: boolean
  className?: string
  renderTile: (
    tile: DashboardTileLayout,
    viewport: DashboardTileViewport,
    context: { interactive: boolean }
  ) => React.ReactNode
  onApply?: (layout: DashboardLayoutSettings) => void | Promise<void>
  onActionsChange?: (actions: React.ReactNode | null) => void
}

function cloneTiles(tiles: DashboardTileLayout[]): DashboardTileLayout[] {
  return tiles.map((tile) => ({ ...tile }))
}

function toLayout(
  base: DashboardLayoutSettings,
  tiles: DashboardTileLayout[]
): DashboardLayoutSettings {
  return {
    version: base.version,
    columns: base.columns,
    tiles: cloneTiles(tiles),
  }
}

/**
 * Header action that adds removed tiles back to the board. Lives in the
 * editing ButtonGroup so the picker never takes vertical space away from the
 * 1fr grid rows; the menu stays open across selections so several tiles can
 * be re-added in one pass, and the last pick falls through to the default
 * close so an empty menu never shows.
 */
function AddTileMenu({
  disabled,
  tiles,
  label,
  unavailable,
  onAdd,
}: {
  disabled: boolean
  tiles: readonly HiddenTileOption[]
  label: string
  unavailable: (reason: DashboardLayoutFailureReason) => string
  onAdd: (id: DashboardTileId) => void
}) {
  const { t } = useTranslation()
  const availableCount = tiles.filter((option) => option.available).length
  return (
    <DropdownMenu>
      <HeaderActionButton
        label={label}
        variant="outline"
        disabled={disabled}
        wrapTrigger={(button) => <DropdownMenuTrigger render={button} />}
      >
        <Plus aria-hidden />
      </HeaderActionButton>
      <DropdownMenuContent align="end">
        {tiles.map(({ tile, available, failureReason }) => {
          const title = t(getDashboardTileDefinition(tile.id).titleKey)
          const reason = failureReason ? unavailable(failureReason) : undefined
          return (
            <DropdownMenuItem
              key={tile.id}
              disabled={!available}
              closeOnClick={availableCount <= 1}
              aria-label={reason ? `${title} ${reason}` : title}
              onClick={() => {
                if (!available) return
                onAdd(tile.id)
              }}
            >
              <span className="min-w-0 flex-1 truncate">{title}</span>
              {reason ? (
                <span className="ml-4 text-[10px] text-muted-foreground">
                  {reason}
                </span>
              ) : null}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function PresetMenu({
  disabled,
  label,
  customLabel,
  undoLabel,
  currentPresetId,
  canUndo,
  onSelect,
  onUndo,
}: {
  disabled: boolean
  label: string
  customLabel: string
  undoLabel: string
  currentPresetId: DashboardLayoutPresetId | null
  canUndo: boolean
  onSelect: (id: DashboardLayoutPresetId) => void
  onUndo: () => void
}) {
  const { t } = useTranslation()
  const currentPreset = DASHBOARD_LAYOUT_PRESETS.find(
    (preset) => preset.id === currentPresetId
  )
  const currentLabel = currentPreset ? t(currentPreset.titleKey) : customLabel

  return (
    <DropdownMenu>
      <HeaderActionButton
        label={`${label}: ${currentLabel}`}
        visibleLabel={currentLabel}
        variant="outline"
        disabled={disabled}
        wrapTrigger={(button) => <DropdownMenuTrigger render={button} />}
      >
        <LayoutTemplate aria-hidden />
      </HeaderActionButton>
      <DropdownMenuContent align="end" className="w-64">
        {DASHBOARD_LAYOUT_PRESETS.map((preset) => (
          <DropdownMenuItem
            key={preset.id}
            className="items-start gap-2"
            onClick={() => onSelect(preset.id)}
          >
            <div className="min-w-0 flex-1">
              <div className="text-sm">{t(preset.titleKey)}</div>
              <div className="text-[11px] text-muted-foreground">
                {t(preset.descriptionKey)}
              </div>
            </div>
            {currentPresetId === preset.id ? (
              <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
            ) : null}
          </DropdownMenuItem>
        ))}
        {canUndo ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onUndo}>
              <Undo2 aria-hidden />
              {undoLabel}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function DashboardGrid({
  layout,
  configureDisabled = false,
  className,
  renderTile,
  onApply,
  onActionsChange,
}: DashboardGridProps) {
  const { t } = useTranslation()
  const compact = useCompactHeader()
  const normalizedTiles = useMemo(
    () => normalizeDashboardLayout(layout.tiles),
    [layout.tiles]
  )
  const rootRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const draftTilesRef = useRef<DashboardTileLayout[]>([])
  const interactionSessionRef = useRef<DashboardInteractionSession | null>(null)
  const interactionWindowCleanupRef = useRef<(() => void) | null>(null)
  const [editing, setEditing] = useState(false)
  const [narrow, setNarrow] = useState(false)
  const [draftTiles, setDraftTiles] =
    useState<DashboardTileLayout[]>(normalizedTiles)
  const [previousPresetDraft, setPreviousPresetDraft] = useState<
    DashboardTileLayout[] | null
  >(null)
  const [draggingId, setDraggingId] = useState<
    DashboardTileLayout['id'] | null
  >(null)
  const [resizingId, setResizingId] = useState<
    DashboardTileLayout['id'] | null
  >(null)
  const [resizePreview, setResizePreview] =
    useState<DashboardResizePreview | null>(null)
  const resizePreviewRef = useRef<DashboardResizePreview | null>(null)
  const [resizeAnnouncementReason, setResizeAnnouncementReason] =
    useState<DashboardLayoutFailureReason | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)

  const clearResizePreview = useCallback(() => {
    resizePreviewRef.current = null
    setResizePreview(null)
    setResizingId(null)
  }, [])

  const cancelActiveInteraction = useCallback(() => {
    const session = interactionSessionRef.current
    if (!session) return

    interactionWindowCleanupRef.current?.()
    interactionWindowCleanupRef.current = null
    cleanupInteractionLifecycle(session, gridRef.current)
    interactionSessionRef.current = null
    setDraggingId(null)
    clearResizePreview()
  }, [clearResizePreview])

  useEffect(() => {
    if (!editing) setDraftTiles(normalizedTiles)
  }, [editing, normalizedTiles])

  const configurationUnavailable = configureDisabled || narrow
  const gridTiles = editing
    ? draftTiles.filter((tile) => tile.enabled)
    : normalizedTiles.filter((tile) => tile.enabled)
  draftTilesRef.current = draftTiles
  const hiddenTiles = useMemo(
    () =>
      editing ? draftTiles.filter((tile) => !tile.enabled) : NO_HIDDEN_TILES,
    [editing, draftTiles]
  )
  const hiddenTileOptions = useMemo(
    () =>
      hiddenTiles.map((tile) => {
        const result = setTileEnabled(draftTiles, tile.id, true)
        return result.ok
          ? { tile, available: true }
          : {
              tile,
              available: false,
              failureReason: result.reason,
            }
      }),
    [draftTiles, hiddenTiles]
  )
  const currentPresetId = useMemo(
    () => matchDashboardPreset(toLayout(layout, draftTiles)),
    [draftTiles, layout]
  )
  const guideRowCount = Math.max(
    DASHBOARD_GUIDE_MIN_ROWS,
    maxTileBottom(gridTiles)
  )

  const startEditing = useCallback(() => {
    if (configurationUnavailable) return
    setDraggingId(null)
    clearResizePreview()
    setResizeAnnouncementReason(null)
    setSaveError(false)
    setPreviousPresetDraft(null)
    setDraftTiles(cloneTiles(normalizedTiles))
    setEditing(true)
  }, [clearResizePreview, configurationUnavailable, normalizedTiles])

  const cancelEditing = useCallback(() => {
    cancelActiveInteraction()
    setDraggingId(null)
    clearResizePreview()
    setResizeAnnouncementReason(null)
    setSaveError(false)
    setPreviousPresetDraft(null)
    setDraftTiles(cloneTiles(normalizedTiles))
    setEditing(false)
  }, [cancelActiveInteraction, clearResizePreview, normalizedTiles])

  const resetDraft = useCallback(() => {
    cancelActiveInteraction()
    setResizeAnnouncementReason(null)
    setSaveError(false)
    setPreviousPresetDraft(null)
    setDraftTiles(applyDashboardPreset('balanced').tiles)
  }, [cancelActiveInteraction])

  const applyDraft = useCallback(async () => {
    cancelActiveInteraction()
    setResizeAnnouncementReason(null)
    const nextLayout = toLayout(layout, draftTiles)
    setSaving(true)
    setSaveError(false)
    try {
      await onApply?.(nextLayout)
      setDraggingId(null)
      setPreviousPresetDraft(null)
      setDraftTiles(cloneTiles(nextLayout.tiles))
      setEditing(false)
    } catch {
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }, [cancelActiveInteraction, draftTiles, layout, onApply])

  const addTile = useCallback(
    (id: DashboardTileId) => {
      cancelActiveInteraction()
      setResizeAnnouncementReason(null)
      setSaveError(false)
      setPreviousPresetDraft(null)
      setDraftTiles((tiles) => {
        const result = setTileEnabled(tiles, id, true)
        return result.ok ? result.tiles : tiles
      })
    },
    [cancelActiveInteraction]
  )

  const removeTile = useCallback(
    (id: DashboardTileId) => {
      cancelActiveInteraction()
      setResizeAnnouncementReason(null)
      setSaveError(false)
      setPreviousPresetDraft(null)
      setDraftTiles((tiles) => {
        const result = setTileEnabled(tiles, id, false)
        return result.ok ? result.tiles : tiles
      })
    },
    [cancelActiveInteraction]
  )

  const applyPreset = useCallback(
    (id: DashboardLayoutPresetId) => {
      cancelActiveInteraction()
      setResizeAnnouncementReason(null)
      setSaveError(false)
      setPreviousPresetDraft(cloneTiles(draftTilesRef.current))
      setDraftTiles(applyDashboardPreset(id).tiles)
    },
    [cancelActiveInteraction]
  )

  const undoPreset = useCallback(() => {
    cancelActiveInteraction()
    setResizeAnnouncementReason(null)
    setPreviousPresetDraft((previous) => {
      if (previous) setDraftTiles(cloneTiles(previous))
      return null
    })
  }, [cancelActiveInteraction])

  const renderInteractionFrame = useCallback(() => {
    const session = interactionSessionRef.current
    const grid = gridRef.current
    if (!session || !grid) return

    session.rafId = null
    const metrics = readDragGridMetrics(grid)
    if (!metrics) return

    if (session.kind === 'move') {
      const target = moveTargetFromPointer(metrics, session)
      const moveResult = moveTile(session.baseTiles, session.id, target)
      session.previewTiles = moveResult.ok
        ? moveResult.tiles
        : session.baseTiles

      const dragged = session.visuals.get(session.id)
      if (dragged) {
        const dx = session.pointerX - session.startPointerX
        const dy = session.pointerY - session.startPointerY
        dragged.element.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.03)`
      }
    } else {
      evaluateResizeSession(session, metrics)
      const geometry = {
        x: session.originTile.x,
        y: session.originTile.y,
        ...session.previewSpan,
      }
      const nextPreview: DashboardResizePreview = {
        id: session.id,
        geometry,
        viewportRect: resizeGhostViewportRect(metrics, geometry),
        valid: session.valid,
        failureReason: session.failureReason,
      }
      if (!sameResizePreview(resizePreviewRef.current, nextPreview)) {
        resizePreviewRef.current = nextPreview
        setResizePreview(nextPreview)
      }
    }

    let settled = true
    const previewById = new Map(
      session.previewTiles.map((tile) => [tile.id, tile])
    )
    for (const [id, visual] of session.visuals) {
      if (id === session.id) continue
      const tile = previewById.get(id)
      if (!tile?.enabled) continue

      const targetOffset = tileCellOffset(metrics, tile)
      visual.targetX = targetOffset.left - visual.rect.left
      visual.targetY = targetOffset.top - visual.rect.top
      if (session.kind === 'resize' && session.reducedMotion) {
        visual.currentX = visual.targetX
        visual.currentY = visual.targetY
      } else {
        visual.currentX += (visual.targetX - visual.currentX) * DRAG_LERP_FACTOR
        visual.currentY += (visual.targetY - visual.currentY) * DRAG_LERP_FACTOR
      }

      if (
        Math.abs(visual.targetX - visual.currentX) > DRAG_SETTLE_EPSILON_PX ||
        Math.abs(visual.targetY - visual.currentY) > DRAG_SETTLE_EPSILON_PX
      ) {
        settled = false
      }

      visual.element.style.transform = `translate3d(${visual.currentX}px, ${visual.currentY}px, 0)`
    }
    if (!settled) {
      scheduleInteractionFrame(session, renderInteractionFrame)
    }
  }, [])

  const scheduleCurrentInteractionFrame = useCallback(() => {
    const session = interactionSessionRef.current
    if (!session) return
    scheduleInteractionFrame(session, renderInteractionFrame)
  }, [renderInteractionFrame])

  const finishInteraction = useCallback(() => {
    const session = interactionSessionRef.current
    if (!session) return
    const grid = gridRef.current
    const metrics = grid ? readDragGridMetrics(grid) : null
    if (metrics) {
      if (session.kind === 'move') {
        const moveResult = moveTile(
          session.baseTiles,
          session.id,
          moveTargetFromPointer(metrics, session)
        )
        session.previewTiles = moveResult.ok
          ? moveResult.tiles
          : session.baseTiles
      } else {
        evaluateResizeSession(session, metrics)
      }
    }
    interactionWindowCleanupRef.current?.()
    interactionWindowCleanupRef.current = null
    flushSync(() => {
      setDraggingId(null)
      clearResizePreview()
      if (session.kind === 'move' || session.valid) {
        setDraftTiles(session.previewTiles)
        setResizeAnnouncementReason(null)
      } else {
        setResizeAnnouncementReason(
          session.failureReason ?? 'insufficient-space'
        )
      }
    })
    cleanupInteractionLifecycle(session, grid)
    interactionSessionRef.current = null
  }, [clearResizePreview])

  const startTileDrag = useCallback(
    (id: DashboardTileId, event: React.PointerEvent<HTMLButtonElement>) => {
      if (
        !editing ||
        saving ||
        interactionSessionRef.current ||
        !isPrimaryPointerStart(event)
      ) {
        return
      }
      setPreviousPresetDraft(null)
      setResizeAnnouncementReason(null)
      const grid = gridRef.current
      const draggedElement = grid ? findTileElement(grid, id) : null
      if (!grid || !draggedElement) return

      event.preventDefault()
      const pointerTarget = event.currentTarget
      const interaction = setupInteractionLifecycle({
        grid,
        tiles: draftTilesRef.current,
        activeElement: draggedElement,
        pointerTarget,
        pointerId: event.pointerId,
        bodyClassName: 'is-dashboard-dragging',
      })
      const session: DashboardMoveSession = {
        kind: 'move',
        id,
        pointerId: event.pointerId,
        pointerX: event.clientX,
        pointerY: event.clientY,
        startPointerX: event.clientX,
        startPointerY: event.clientY,
        baseTiles: cloneTiles(draftTilesRef.current),
        previewTiles: cloneTiles(draftTilesRef.current),
        visuals: interaction.visuals,
        rafId: null,
        gridPreviousTouchAction: interaction.gridPreviousTouchAction,
        bodyClassName: interaction.bodyClassName,
        releasePointerCapture: interaction.releasePointerCapture,
      }

      interactionSessionRef.current = session
      setDraggingId(id)

      interactionWindowCleanupRef.current = listenForInteractionPointer(
        session,
        scheduleCurrentInteractionFrame,
        finishInteraction,
        cancelActiveInteraction
      )
      scheduleCurrentInteractionFrame()
    },
    [
      cancelActiveInteraction,
      editing,
      finishInteraction,
      saving,
      scheduleCurrentInteractionFrame,
    ]
  )

  const startTileResize = useCallback(
    (id: DashboardTileId, event: React.PointerEvent<HTMLButtonElement>) => {
      if (
        !editing ||
        saving ||
        interactionSessionRef.current ||
        !isPrimaryPointerStart(event)
      ) {
        return
      }

      const originTile = draftTilesRef.current.find(
        (tile) => tile.id === id && tile.enabled
      )
      const grid = gridRef.current
      const sourceElement = grid ? findTileElement(grid, id) : null
      if (!originTile || !grid || !sourceElement) return

      event.preventDefault()
      event.stopPropagation()
      setSaveError(false)
      setPreviousPresetDraft(null)
      setResizeAnnouncementReason(null)
      clearResizePreview()

      const pointerTarget = event.currentTarget
      const interaction = setupInteractionLifecycle({
        grid,
        tiles: draftTilesRef.current,
        activeElement: sourceElement,
        pointerTarget,
        pointerId: event.pointerId,
        bodyClassName: 'is-dashboard-resizing',
        elevateActiveElement: false,
      })
      const session: DashboardResizeSession = {
        kind: 'resize',
        id,
        pointerId: event.pointerId,
        pointerX: event.clientX,
        pointerY: event.clientY,
        originTile: { ...originTile },
        baseTiles: cloneTiles(draftTilesRef.current),
        previewTiles: cloneTiles(draftTilesRef.current),
        previewSpan: { w: originTile.w, h: originTile.h },
        valid: true,
        visuals: interaction.visuals,
        rafId: null,
        gridPreviousTouchAction: interaction.gridPreviousTouchAction,
        bodyClassName: interaction.bodyClassName,
        releasePointerCapture: interaction.releasePointerCapture,
        reducedMotion:
          typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      }

      interactionSessionRef.current = session
      setResizingId(id)
      interactionWindowCleanupRef.current = listenForInteractionPointer(
        session,
        scheduleCurrentInteractionFrame,
        finishInteraction,
        cancelActiveInteraction
      )
      scheduleCurrentInteractionFrame()
    },
    [
      cancelActiveInteraction,
      clearResizePreview,
      editing,
      finishInteraction,
      saving,
      scheduleCurrentInteractionFrame,
    ]
  )

  useEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return

    const observer = new ResizeObserver(([entry]) => {
      const width =
        entry?.contentRect.width ?? root.getBoundingClientRect().width
      setNarrow(width > 0 && width < DASHBOARD_LAYOUT_MIN_WIDTH_PX)
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  useEffect(
    () => () => {
      const session = interactionSessionRef.current
      if (session) {
        interactionWindowCleanupRef.current?.()
        interactionWindowCleanupRef.current = null
        cleanupInteractionLifecycle(session, gridRef.current)
        interactionSessionRef.current = null
      }
    },
    []
  )

  useEffect(() => {
    if (!editing || !configurationUnavailable) return

    cancelActiveInteraction()
    setDraggingId(null)
    clearResizePreview()
    setResizeAnnouncementReason(null)
    setSaveError(false)
    setPreviousPresetDraft(null)
    setDraftTiles(cloneTiles(normalizedTiles))
    setEditing(false)
  }, [
    cancelActiveInteraction,
    clearResizePreview,
    configurationUnavailable,
    editing,
    normalizedTiles,
  ])

  const label = useMemo(
    () => ({
      action: t('panel.dashboard.configure.action', {
        defaultValue: 'Configure',
      }),
      addTile: t('panel.dashboard.configure.addTile', {
        defaultValue: 'Add',
      }),
      apply: t('panel.dashboard.configure.apply', { defaultValue: 'Apply' }),
      cancel: t('panel.dashboard.configure.cancel', {
        defaultValue: 'Cancel',
      }),
      reset: t('panel.dashboard.configure.reset', { defaultValue: 'Reset' }),
      presets: t('panel.dashboard.configure.presets.action', {
        defaultValue: 'Presets',
      }),
      customPreset: t('panel.dashboard.configure.presets.custom', {
        defaultValue: 'Custom',
      }),
      undoPreset: t('panel.dashboard.configure.presets.undo', {
        defaultValue: 'Undo last preset',
      }),
      drag: t('panel.dashboard.configure.drag', { defaultValue: 'Drag tile' }),
      resize: t('panel.dashboard.configure.resizeTile', {
        defaultValue: 'Resize tile',
      }),
      remove: t('panel.dashboard.configure.removeTile', {
        defaultValue: 'Remove tile',
      }),
      saveFailed: t('panel.dashboard.configure.saveFailed', {
        defaultValue: 'Could not save layout. Try again.',
      }),
      sizeGroup: t('panel.dashboard.configure.sizeGroup', {
        defaultValue: 'Tile size',
      }),
      currentSize: (span: DashboardTileSpan) =>
        t('panel.dashboard.configure.currentSize', {
          width: span.w,
          height: span.h,
          defaultValue: `Current size: ${span.w} × ${span.h}`,
        }),
      invalidCapacity: t('panel.dashboard.configure.invalidCapacity', {
        defaultValue: 'Not enough space for this size',
      }),
      unavailable: {
        'unsupported-span': t(
          'panel.dashboard.configure.sizeUnavailable.unsupported',
          { defaultValue: 'Unsupported' }
        ),
        'out-of-bounds': t(
          'panel.dashboard.configure.sizeUnavailable.outOfBounds',
          { defaultValue: 'Does not fit' }
        ),
        'insufficient-space': t(
          'panel.dashboard.configure.sizeUnavailable.insufficientSpace',
          { defaultValue: 'Not enough space' }
        ),
      },
      expandHint: t('panel.dashboard.configure.expandHint', {
        defaultValue: 'Expand the window to configure Dashboard layout.',
      }),
    }),
    [t]
  )

  const actions = useMemo(
    () =>
      editing ? (
        <ButtonGroup>
          <ButtonGroup>
            <HeaderActionButton
              label={label.cancel}
              variant="outline"
              onClick={cancelEditing}
              disabled={saving}
            >
              <X aria-hidden />
            </HeaderActionButton>
            <HeaderActionButton
              label={label.reset}
              variant="outline"
              onClick={resetDraft}
              disabled={saving}
            >
              <RotateCcw aria-hidden />
            </HeaderActionButton>
            <HeaderActionButton
              label={label.apply}
              onClick={() => void applyDraft()}
              disabled={saving}
            >
              <Check aria-hidden />
            </HeaderActionButton>
          </ButtonGroup>
          <ButtonGroup>
            <PresetMenu
              disabled={saving}
              label={label.presets}
              customLabel={label.customPreset}
              undoLabel={label.undoPreset}
              currentPresetId={currentPresetId}
              canUndo={previousPresetDraft !== null}
              onSelect={applyPreset}
              onUndo={undoPreset}
            />
            <AddTileMenu
              disabled={saving || hiddenTileOptions.length === 0}
              tiles={hiddenTileOptions}
              label={label.addTile}
              unavailable={(reason) => label.unavailable[reason]}
              onAdd={addTile}
            />
          </ButtonGroup>
        </ButtonGroup>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={label.action}
                className={cn(
                  'panel-action-align-visual-end relative size-7 bg-transparent hover:bg-transparent dark:hover:bg-transparent',
                  compact && COMPACT_ACTION_CLASS
                )}
                disabled={configurationUnavailable}
                onClick={startEditing}
              />
            }
          >
            <SlidersHorizontal aria-hidden className="size-4" />
          </TooltipTrigger>
          {configurationUnavailable ? (
            <TooltipContent>{label.expandHint}</TooltipContent>
          ) : (
            <TooltipContent>{label.action}</TooltipContent>
          )}
        </Tooltip>
      ),
    [
      addTile,
      applyPreset,
      applyDraft,
      cancelEditing,
      compact,
      configurationUnavailable,
      currentPresetId,
      editing,
      label,
      hiddenTileOptions,
      previousPresetDraft,
      resetDraft,
      saving,
      startEditing,
      undoPreset,
    ]
  )

  const actionsForExternalSlot = useMemo(
    () => <TooltipProvider>{actions}</TooltipProvider>,
    [actions]
  )

  useEffect(() => {
    if (!onActionsChange) return
    onActionsChange(actionsForExternalSlot)
    return () => onActionsChange(null)
  }, [actionsForExternalSlot, onActionsChange])

  return (
    <TooltipProvider>
      <div
        ref={rootRef}
        className={cn('@container flex min-h-0 flex-1 flex-col', className)}
      >
        {onActionsChange ? null : (
          <div className="mb-3 flex shrink-0 justify-end">{actions}</div>
        )}
        {saveError ? (
          <div
            role="status"
            className="mb-2 shrink-0 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] text-destructive"
          >
            {label.saveFailed}
          </div>
        ) : null}
        {/* Below the breakpoint the grid stacks into one column: rows size to
            content (8rem floor) and this wrapper becomes the one scroller.
            At @[560px]+ the grid is height-clamped again and 1fr rows stretch
            to keep the balanced board look — no scrolling. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto @[560px]:overflow-visible">
          <div
            data-testid="dashboard-grid"
            className={cn(
              'relative grid grid-cols-1 gap-4 pt-3 auto-rows-[minmax(8rem,auto)] @[560px]:pt-0',
              '@[560px]:min-h-0 @[560px]:flex-1 @[560px]:grid-cols-4 @[560px]:grid-rows-[repeat(3,minmax(8rem,1fr))] @[560px]:auto-rows-[minmax(8rem,1fr)]',
              draggingId && 'cursor-grabbing',
              resizingId && 'cursor-nwse-resize'
            )}
            ref={gridRef}
          >
            {/* One slot per cell: real grid items align with tracks and gaps
                exactly, and none of this takes layout space away from tiles.
                Hidden below the breakpoint where configuring is unavailable. */}
            {editing
              ? Array.from(
                  { length: guideRowCount * DASHBOARD_COLUMNS },
                  (_, index) => (
                    <div
                      // biome-ignore lint/suspicious/noArrayIndexKey: slots are positional by definition
                      key={index}
                      data-testid="dashboard-grid-guide"
                      aria-hidden
                      className="pointer-events-none hidden border border-dashed border-muted-foreground/40 [border-radius:var(--dashboard-tile-radius)] @[560px]:block"
                      style={{
                        gridColumn: (index % DASHBOARD_COLUMNS) + 1,
                        gridRow: Math.floor(index / DASHBOARD_COLUMNS) + 1,
                      }}
                    />
                  )
                )
              : null}
            {gridTiles.map((tile) => (
              <DashboardTileFrame
                key={tile.id}
                tile={tile}
                sizeOptions={getDashboardTileSizeOptions(
                  editing ? draftTiles : normalizedTiles,
                  tile.id
                )}
                editing={editing}
                dragging={draggingId === tile.id}
                labels={{
                  drag: label.drag,
                  resize: label.resize,
                  remove: label.remove,
                  sizeGroup: label.sizeGroup,
                  size: (_size, presentation) => {
                    const sizeLabel = t(
                      `panel.dashboard.configure.sizeLabels.${dashboardTileSizeLabel(presentation)}`
                    )
                    const dimensions = t('panel.dashboard.configure.size', {
                      width: presentation.span.w,
                      height: presentation.span.h,
                      defaultValue: `${presentation.span.w} × ${presentation.span.h}`,
                    })
                    return `${sizeLabel} · ${dimensions}`
                  },
                  unavailable: (reason) => label.unavailable[reason],
                }}
                onResize={(id, span) => {
                  cancelActiveInteraction()
                  setResizeAnnouncementReason(null)
                  setSaveError(false)
                  setPreviousPresetDraft(null)
                  setDraftTiles((tiles) => {
                    const result = resizeTile(tiles, id, span)
                    return result.ok ? result.tiles : tiles
                  })
                }}
                onDragHandlePointerDown={(id, event) => {
                  startTileDrag(id, event)
                }}
                onResizeHandlePointerDown={(id, event) => {
                  startTileResize(id, event)
                }}
                onRemove={removeTile}
              >
                {renderTile(tile, dashboardTileViewport(tile.id, tile), {
                  interactive: !editing,
                })}
              </DashboardTileFrame>
            ))}
            {resizePreview ? (
              <DashboardResizeGhost
                geometry={resizePreview.geometry}
                viewportRect={resizePreview.viewportRect}
                valid={resizePreview.valid}
                sizeLabel={label.currentSize(resizePreview.geometry)}
                failure={
                  resizePreview.valid ? undefined : label.invalidCapacity
                }
              />
            ) : null}
          </div>
        </div>
        {resizeAnnouncementReason ? (
          <div
            role="status"
            aria-live="polite"
            data-testid="dashboard-resize-announcement"
            className="sr-only"
          >
            {label.invalidCapacity}
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  )
}
