import type { TooltipRootChangeEventDetails } from '@base-ui/react/tooltip'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { formatDateTime } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import type { TaskActivitySnapshot } from '@shared/types/task-activity'
import { useTheme } from 'next-themes'
import {
  type KeyboardEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { DashboardTileContentLevel } from '../layout/dashboard-registry'
import {
  type ActivityCalendarCell,
  type ActivityCalendarGeometry,
  type ActivityNavigationKey,
  activityMonthLabels,
  buildActivityCells,
  defaultActivityActiveIndex,
  hitTestActivityCell,
  maxActivityWeeks,
  moveActivityActiveIndex,
  projectActivityCells,
  selectActivityGeometry,
} from './activity-calendar-model'

const KEY_ROOT = 'panel.dashboard.activity'
const CALENDAR_MIN_HEIGHT_CLASS = 'min-h-[56px]'
const LABEL_FONT_SIZE = 10
export const ACTIVITY_TOOLTIP_OPEN_DELAY_MS = 300
export const ACTIVITY_TOOLTIP_CLOSE_GRACE_MS = 100
export const ACTIVITY_TOOLTIP_SKIP_DELAY_MS = 300

interface ActivityCalendarRenderState {
  geometry: ActivityCalendarGeometry | null
  cells: ActivityCalendarCell[]
}

type ActivityInteractionMode = 'pointer' | 'keyboard' | 'direct'

interface ActivityCanvasPalette {
  levels: readonly [string, string, string, string, string]
}

function activityLevelOpacity(depth: number, dark: boolean): number | null {
  if (depth === 0) return null
  const light = [0, 0.22, 0.42, 0.68, 0.95] as const
  const darkMode = [0, 0.25, 0.45, 0.7, 1] as const
  return (dark ? darkMode : light)[depth] ?? null
}

export interface ActivityCalendarProps {
  snapshot: TaskActivitySnapshot
  contentLevel: DashboardTileContentLevel
  interactive?: boolean
  now?: Date
  className?: string
}

function cssToken(
  styles: CSSStyleDeclaration,
  name: string,
  fallback: string
): string {
  return styles.getPropertyValue(name).trim() || fallback
}

function currentLocalDayMs(): number {
  const current = new Date()
  return new Date(
    current.getFullYear(),
    current.getMonth(),
    current.getDate()
  ).getTime()
}

function interactionNowMs(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

// The palette depends only on the resolved theme and the stylesheet, so cache
// it instead of forcing a style recalculation on every canvas frame.
let paletteCache: {
  theme: string | undefined
  palette: ActivityCanvasPalette
} | null = null

function readPalette(
  canvas: HTMLCanvasElement,
  resolvedTheme: string | undefined
): ActivityCanvasPalette {
  if (paletteCache && paletteCache.theme === resolvedTheme) {
    return paletteCache.palette
  }

  const styles = getComputedStyle(canvas)
  const chart = cssToken(styles, '--chart-1', '193 83% 50%')
  const dark = resolvedTheme === 'dark'
  const colorForDepth = (depth: number) =>
    `hsl(${chart} / ${activityLevelOpacity(depth, dark) ?? 0})`

  const palette: ActivityCanvasPalette = {
    levels: [
      cssToken(styles, '--muted', dark ? '#30363d' : '#ebedf0'),
      colorForDepth(1),
      colorForDepth(2),
      colorForDepth(3),
      colorForDepth(4),
    ],
  }
  paletteCache = { theme: resolvedTheme, palette }
  return palette
}

function cellPosition(
  geometry: ActivityCalendarGeometry,
  index: number
): { left: number; top: number } {
  return {
    left: geometry.gridLeft + Math.floor(index / 7) * geometry.stride,
    top: geometry.gridTop + (index % 7) * geometry.stride,
  }
}

function isActivityCellGap(
  geometry: ActivityCalendarGeometry,
  x: number,
  y: number
): boolean {
  const relativeX = x - geometry.gridLeft
  const relativeY = y - geometry.gridTop
  if (
    relativeX < 0 ||
    relativeY < 0 ||
    relativeX >= geometry.gridWidth ||
    relativeY >= geometry.gridHeight
  ) {
    return false
  }

  const column = Math.floor(relativeX / geometry.stride)
  const row = Math.floor(relativeY / geometry.stride)
  if (column < 0 || column >= geometry.weeks || row < 0 || row >= 7) {
    return false
  }

  const horizontalGap =
    relativeX % geometry.stride >= geometry.cellSize &&
    column < geometry.weeks - 1
  const verticalGap =
    relativeY % geometry.stride >= geometry.cellSize && row < 6
  return horizontalGap || verticalGap
}

export function drawActivityCanvas(
  canvas: HTMLCanvasElement,
  cells: readonly ActivityCalendarCell[],
  geometry: ActivityCalendarGeometry,
  resolvedTheme: string | undefined,
  dpr: number
): void {
  const safeDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1
  const targetWidth = Math.round(geometry.width * safeDpr)
  const targetHeight = Math.round(geometry.height * safeDpr)

  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth
    canvas.height = targetHeight
  }
  canvas.style.width = `${geometry.width}px`
  canvas.style.height = `${geometry.height}px`

  const context = canvas.getContext('2d')
  if (!context) return

  context.setTransform(safeDpr, 0, 0, safeDpr, 0, 0)
  context.clearRect(0, 0, geometry.width, geometry.height)
  const palette = readPalette(canvas, resolvedTheme)
  const radius = Math.min(2, geometry.cellSize * 0.22)

  for (let depth = 0; depth <= 4; depth += 1) {
    context.fillStyle = palette.levels[depth] ?? palette.levels[0]
    context.beginPath()
    let hasCells = false
    for (let index = 0; index < cells.length; index += 1) {
      const cell = cells[index]
      if (!cell || cell.depth !== depth || cell.tracking === 'future') {
        continue
      }
      const position = cellPosition(geometry, index)
      context.roundRect(
        position.left,
        position.top,
        geometry.cellSize,
        geometry.cellSize,
        radius
      )
      hasCells = true
    }
    if (hasCells) context.fill()
  }
}

function geometryEqual(
  left: ActivityCalendarGeometry | null,
  right: ActivityCalendarGeometry | null
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.width === right.width &&
    left.height === right.height &&
    left.weeks === right.weeks &&
    left.cellSize === right.cellSize &&
    left.gap === right.gap &&
    left.gridLeft === right.gridLeft &&
    left.gridTop === right.gridTop &&
    left.showLegend === right.showLegend &&
    left.showMonthLabels === right.showMonthLabels &&
    left.showWeekdayLabels === right.showWeekdayLabels
  )
}

function cellsEqual(
  left: readonly ActivityCalendarCell[],
  right: readonly ActivityCalendarCell[]
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((cell, index) => cell === right[index])
}

function cellProjectionEqual(
  left: readonly ActivityCalendarCell[],
  right: readonly ActivityCalendarCell[]
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((cell, index) => cell.dateKey === right[index]?.dateKey)
}

function navigationKey(value: string): ActivityNavigationKey | null {
  switch (value) {
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown':
    case 'Home':
    case 'End':
    case 'PageUp':
    case 'PageDown':
      return value
    default:
      return null
  }
}

export function ActivityCalendar({
  snapshot,
  contentLevel,
  interactive = true,
  now,
  className,
}: ActivityCalendarProps) {
  const { t, i18n } = useTranslation()
  const { resolvedTheme } = useTheme()
  const generatedId = useId().replaceAll(':', '')
  const summaryId = `activity-calendar-summary-${generatedId}`
  const cellId = `activity-calendar-cell-${generatedId}`
  const tooltipTriggerId = `activity-calendar-tooltip-trigger-${generatedId}`
  const modelNowMs = now?.getTime() ?? currentLocalDayMs()
  const maxWeeks = maxActivityWeeks(contentLevel)
  const allCells = useMemo(
    () => buildActivityCells(snapshot, new Date(modelNowMs)),
    [modelNowMs, snapshot]
  )

  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const tooltipAnchorRef = useRef<HTMLSpanElement>(null)
  const scheduleRef = useRef<(() => void) | null>(null)
  const projectionCacheRef = useRef<{
    source: readonly ActivityCalendarCell[]
    weeks: number
    cells: ActivityCalendarCell[]
  } | null>(null)
  const latestRef = useRef({ allCells, contentLevel, resolvedTheme })

  const [renderState, setRenderState] = useState<ActivityCalendarRenderState>({
    geometry: null,
    cells: [],
  })
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [gridFocused, setGridFocused] = useState(false)
  const [interactionMode, setInteractionModeState] =
    useState<ActivityInteractionMode>('pointer')
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const activeDateKeyRef = useRef<string | null>(null)
  const containerRectRef = useRef<DOMRect | null>(null)
  const hoveredDateKeyRef = useRef<string | null>(null)
  const pointerTargetDateKeyRef = useRef<string | null>(null)
  const activeTracksTodayRef = useRef(true)
  const cellsRef = useRef<readonly ActivityCalendarCell[]>([])
  const interactionGeometryRef = useRef<ActivityCalendarGeometry | null>(null)
  const interactiveRef = useRef(interactive)
  const gridFocusedRef = useRef(false)
  const interactionModeRef = useRef<ActivityInteractionMode>('pointer')
  const pointerFocusPendingRef = useRef(false)
  const tooltipOpenRef = useRef(false)
  const tooltipOpenTimerRef = useRef<number | null>(null)
  const tooltipCloseTimerRef = useRef<number | null>(null)
  const tooltipWarmUntilRef = useRef(0)

  const clearTooltipOpenTimer = useCallback(() => {
    if (tooltipOpenTimerRef.current === null) return
    window.clearTimeout(tooltipOpenTimerRef.current)
    tooltipOpenTimerRef.current = null
  }, [])

  const clearTooltipCloseTimer = useCallback(() => {
    if (tooltipCloseTimerRef.current === null) return
    window.clearTimeout(tooltipCloseTimerRef.current)
    tooltipCloseTimerRef.current = null
  }, [])

  const setTooltipVisibility = useCallback((open: boolean) => {
    tooltipOpenRef.current = open
    setTooltipOpen(open)
  }, [])

  const setInteractionMode = useCallback((mode: ActivityInteractionMode) => {
    if (interactionModeRef.current === mode) return
    interactionModeRef.current = mode
    setInteractionModeState(mode)
  }, [])

  const clearPointerTooltip = useCallback(
    (resetWarmInterval: boolean) => {
      clearTooltipOpenTimer()
      clearTooltipCloseTimer()
      pointerTargetDateKeyRef.current = null
      hoveredDateKeyRef.current = null
      setHoveredIndex(null)
      if (resetWarmInterval) tooltipWarmUntilRef.current = 0
      if (!gridFocusedRef.current || interactionModeRef.current === 'pointer') {
        setTooltipVisibility(false)
      }
    },
    [clearTooltipCloseTimer, clearTooltipOpenTimer, setTooltipVisibility]
  )

  const activateKeyboardMode = useCallback(() => {
    clearTooltipOpenTimer()
    clearTooltipCloseTimer()
    tooltipWarmUntilRef.current = 0
    pointerTargetDateKeyRef.current = null
    hoveredDateKeyRef.current = null
    setHoveredIndex(null)
    setInteractionMode('keyboard')
  }, [clearTooltipCloseTimer, clearTooltipOpenTimer, setInteractionMode])

  useLayoutEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    let frameId: number | null = null
    let measuredWidth = container.clientWidth
    let measuredHeight = container.clientHeight
    let dprQuery: MediaQueryList | null = null

    const renderFrame = () => {
      frameId = null
      const width = measuredWidth || container.clientWidth
      const height = measuredHeight || container.clientHeight
      const latest = latestRef.current
      const geometry = selectActivityGeometry({
        width,
        height,
        contentLevel: latest.contentLevel,
      })
      const cachedProjection = projectionCacheRef.current
      const visibleCells = geometry
        ? cachedProjection?.source === latest.allCells &&
          cachedProjection.weeks === geometry.weeks
          ? cachedProjection.cells
          : projectActivityCells(latest.allCells, geometry.weeks)
        : []
      if (
        geometry &&
        (cachedProjection?.source !== latest.allCells ||
          cachedProjection.weeks !== geometry.weeks)
      ) {
        projectionCacheRef.current = {
          source: latest.allCells,
          weeks: geometry.weeks,
          cells: visibleCells,
        }
      }

      if (geometry) {
        drawActivityCanvas(
          canvas,
          visibleCells,
          geometry,
          latest.resolvedTheme,
          window.devicePixelRatio || 1
        )
      }

      setRenderState((current) =>
        geometryEqual(current.geometry, geometry) &&
        cellsEqual(current.cells, visibleCells)
          ? current
          : { geometry, cells: visibleCells }
      )
    }

    const schedule = () => {
      if (frameId !== null) return
      frameId = requestAnimationFrame(renderFrame)
    }
    scheduleRef.current = schedule

    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            const entry = entries.find((item) => item.target === container)
            if (!entry) return
            measuredWidth = entry.contentRect.width
            measuredHeight = entry.contentRect.height
            containerRectRef.current = container.getBoundingClientRect()
            schedule()
          })
    resizeObserver?.observe(container)

    const handleDprChange = () => {
      bindDprQuery()
      schedule()
    }
    const bindDprQuery = () => {
      dprQuery?.removeEventListener('change', handleDprChange)
      dprQuery =
        typeof window.matchMedia === 'function'
          ? window.matchMedia(
              `(resolution: ${window.devicePixelRatio || 1}dppx)`
            )
          : null
      dprQuery?.addEventListener('change', handleDprChange)
    }
    bindDprQuery()
    schedule()

    return () => {
      scheduleRef.current = null
      if (frameId !== null) cancelAnimationFrame(frameId)
      resizeObserver?.disconnect()
      dprQuery?.removeEventListener('change', handleDprChange)
    }
  }, [])

  useLayoutEffect(() => {
    latestRef.current = { allCells, contentLevel, resolvedTheme }
    scheduleRef.current?.()
  }, [allCells, contentLevel, resolvedTheme])

  useLayoutEffect(() => {
    const interactionGeometryChanged = !geometryEqual(
      interactionGeometryRef.current,
      renderState.geometry
    )
    const interactionProjectionChanged = !cellProjectionEqual(
      cellsRef.current,
      renderState.cells
    )
    cellsRef.current = renderState.cells
    interactionGeometryRef.current = renderState.geometry
    interactiveRef.current = interactive
    if (interactionGeometryChanged) {
      clearTooltipCloseTimer()
    }
    if (interactionGeometryChanged || interactionProjectionChanged) {
      clearTooltipOpenTimer()
      pointerTargetDateKeyRef.current = null
      tooltipWarmUntilRef.current = 0
    }
  }, [
    clearTooltipCloseTimer,
    clearTooltipOpenTimer,
    interactive,
    renderState.cells,
    renderState.geometry,
  ])

  useEffect(
    () => () => {
      clearTooltipOpenTimer()
      clearTooltipCloseTimer()
    },
    [clearTooltipCloseTimer, clearTooltipOpenTimer]
  )

  const setActive = useCallback(
    (index: number | null, tracksToday = false) => {
      setActiveIndex(index)
      activeTracksTodayRef.current = tracksToday
      activeDateKeyRef.current =
        index === null ? null : (renderState.cells[index]?.dateKey ?? null)
    },
    [renderState.cells]
  )

  useLayoutEffect(() => {
    if (renderState.cells.length === 0) {
      setActive(null, true)
      clearPointerTooltip(false)
      return
    }
    const preservedIndex = activeDateKeyRef.current
      ? renderState.cells.findIndex(
          (cell) => cell.dateKey === activeDateKeyRef.current
        )
      : -1
    const tracksToday = activeTracksTodayRef.current || preservedIndex < 0
    setActive(
      tracksToday
        ? defaultActivityActiveIndex(renderState.cells)
        : preservedIndex,
      tracksToday
    )

    if (hoveredDateKeyRef.current) {
      const preservedHoveredIndex = renderState.cells.findIndex(
        (cell) => cell.dateKey === hoveredDateKeyRef.current
      )
      if (preservedHoveredIndex >= 0) {
        setHoveredIndex(preservedHoveredIndex)
      } else {
        clearPointerTooltip(false)
      }
    }
  }, [clearPointerTooltip, renderState.cells, setActive])

  useEffect(() => {
    if (interactive) return
    clearPointerTooltip(true)
    pointerFocusPendingRef.current = false
    gridFocusedRef.current = false
    setGridFocused(false)
    setInteractionMode('pointer')
    setTooltipVisibility(false)
    containerRef.current?.blur()
  }, [
    clearPointerTooltip,
    interactive,
    setInteractionMode,
    setTooltipVisibility,
  ])

  const geometry = renderState.geometry
  const cells = renderState.cells
  const focusOwnsTooltip = gridFocused && interactionMode !== 'pointer'
  const tooltipIndex = focusOwnsTooltip ? activeIndex : hoveredIndex
  const tooltipCell =
    tooltipIndex === null ? null : (cells[tooltipIndex] ?? null)

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        dateStyle: 'medium',
      }),
    [i18n.language]
  )
  const monthFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        month: 'short',
      }),
    [i18n.language]
  )
  const describeCell = useCallback(
    (cell: ActivityCalendarCell): string => {
      if (cell.tracking === 'untracked') {
        return [
          dateFormatter.format(cell.fromMs),
          t(`${KEY_ROOT}.tooltip.untracked`),
        ].join('. ')
      }
      const parts = [
        dateFormatter.format(cell.fromMs),
        t(`${KEY_ROOT}.tooltip.completed`, {
          count: cell.downloadCompleted,
        }),
        t(`${KEY_ROOT}.tooltip.submitted`, { count: cell.submitted }),
      ]
      if (cell.recoveredDownloadCompleted > 0) {
        parts.push(t(`${KEY_ROOT}.tooltip.recovered`))
      }
      if (cell.tracking === 'partial') {
        parts.push(
          t(`${KEY_ROOT}.tooltip.partial`, {
            time: formatDateTime(
              snapshot.coverage.trackingStartedAt,
              i18n.language
            ),
          })
        )
      }
      if (cell.coverageDegraded) {
        parts.push(
          t(`${KEY_ROOT}.tooltip.coverage`, {
            time: formatDateTime(
              snapshot.coverage.coverageGapAt ?? cell.fromMs,
              i18n.language
            ),
          })
        )
      }
      if (cell.today) parts.push(t(`${KEY_ROOT}.tooltip.today`))
      return parts.join('. ')
    },
    [
      dateFormatter,
      i18n.language,
      snapshot.coverage.coverageGapAt,
      snapshot.coverage.trackingStartedAt,
      t,
    ]
  )

  const rangeSummary = useMemo(() => {
    const first = cells[0]
    const last =
      cells.findLast((cell) => cell.tracking !== 'future') ?? cells.at(-1)
    if (!first || !last || !geometry) return ''
    return t(`${KEY_ROOT}.rangeSummary`, {
      start: dateFormatter.format(first.fromMs),
      end: dateFormatter.format(last.fromMs),
      weeks: geometry.weeks,
    })
  }, [cells, dateFormatter, geometry, t])

  const targetPointerCell = useCallback(
    (index: number) => {
      const dateKey = cells[index]?.dateKey
      if (!dateKey) return

      clearTooltipCloseTimer()
      if (pointerTargetDateKeyRef.current !== dateKey) {
        clearTooltipOpenTimer()
        pointerTargetDateKeyRef.current = dateKey
      }
      if (gridFocusedRef.current && interactionModeRef.current !== 'pointer') {
        return
      }

      if (tooltipOpenRef.current) {
        if (hoveredDateKeyRef.current !== dateKey) {
          hoveredDateKeyRef.current = dateKey
          setHoveredIndex(index)
        }
        return
      }
      if (interactionNowMs() < tooltipWarmUntilRef.current) {
        hoveredDateKeyRef.current = dateKey
        setHoveredIndex(index)
        setTooltipVisibility(true)
        return
      }
      if (tooltipOpenTimerRef.current !== null) return

      tooltipOpenTimerRef.current = window.setTimeout(() => {
        tooltipOpenTimerRef.current = null
        if (
          !interactiveRef.current ||
          (gridFocusedRef.current &&
            interactionModeRef.current !== 'pointer') ||
          pointerTargetDateKeyRef.current !== dateKey
        ) {
          return
        }
        const currentIndex = cellsRef.current.findIndex(
          (cell) => cell.dateKey === dateKey
        )
        const currentCell = cellsRef.current[currentIndex]
        if (!currentCell || currentCell.tracking === 'future') {
          pointerTargetDateKeyRef.current = null
          return
        }
        hoveredDateKeyRef.current = dateKey
        setHoveredIndex(currentIndex)
        setTooltipVisibility(true)
      }, ACTIVITY_TOOLTIP_OPEN_DELAY_MS)
    },
    [cells, clearTooltipCloseTimer, clearTooltipOpenTimer, setTooltipVisibility]
  )

  const targetPointerGap = useCallback(() => {
    pointerTargetDateKeyRef.current = null
    clearTooltipOpenTimer()
    if (gridFocusedRef.current && interactionModeRef.current !== 'pointer') {
      return
    }

    if (!tooltipOpenRef.current) {
      hoveredDateKeyRef.current = null
      setHoveredIndex(null)
      return
    }
    if (tooltipCloseTimerRef.current !== null) return

    tooltipCloseTimerRef.current = window.setTimeout(() => {
      tooltipCloseTimerRef.current = null
      if (
        !interactiveRef.current ||
        (gridFocusedRef.current && interactionModeRef.current !== 'pointer') ||
        pointerTargetDateKeyRef.current !== null
      ) {
        return
      }
      tooltipWarmUntilRef.current =
        interactionNowMs() + ACTIVITY_TOOLTIP_SKIP_DELAY_MS
      hoveredDateKeyRef.current = null
      setHoveredIndex(null)
      setTooltipVisibility(false)
    }, ACTIVITY_TOOLTIP_CLOSE_GRACE_MS)
  }, [clearTooltipOpenTimer, setTooltipVisibility])

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (
        !interactive ||
        !geometry ||
        event.pointerType === 'touch' ||
        (event.pointerType === 'pen' && event.buttons > 0)
      ) {
        return
      }
      let rect = containerRectRef.current
      if (!rect) {
        rect = event.currentTarget.getBoundingClientRect()
        containerRectRef.current = rect
      }
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      const index = hitTestActivityCell(geometry, cells, x, y)
      if (index === null) {
        if (isActivityCellGap(geometry, x, y)) {
          targetPointerGap()
        } else {
          clearPointerTooltip(true)
        }
      } else {
        setInteractionMode('pointer')
        targetPointerCell(index)
      }
    },
    [
      cells,
      clearPointerTooltip,
      geometry,
      interactive,
      setInteractionMode,
      targetPointerCell,
      targetPointerGap,
    ]
  )

  const handlePointerEnter = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      containerRectRef.current = event.currentTarget.getBoundingClientRect()
      handlePointerMove(event)
    },
    [handlePointerMove]
  )

  const handlePointerLeave = useCallback(() => {
    clearPointerTooltip(true)
  }, [clearPointerTooltip])

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!interactive || !geometry) return
      const rect = event.currentTarget.getBoundingClientRect()
      containerRectRef.current = rect
      const index = hitTestActivityCell(
        geometry,
        cells,
        event.clientX - rect.left,
        event.clientY - rect.top
      )
      clearTooltipOpenTimer()
      clearTooltipCloseTimer()
      tooltipWarmUntilRef.current = 0
      event.preventDefault()
      if (index === null) {
        setInteractionMode('pointer')
        pointerTargetDateKeyRef.current = null
        hoveredDateKeyRef.current = null
        setHoveredIndex(null)
        setTooltipVisibility(false)
        return
      }
      const dateKey = cells[index]?.dateKey
      if (!dateKey) return
      const directActivation =
        event.pointerType === 'touch' || event.pointerType === 'pen'
      setInteractionMode(directActivation ? 'direct' : 'pointer')
      pointerTargetDateKeyRef.current = dateKey
      hoveredDateKeyRef.current = dateKey
      setHoveredIndex(index)
      setActive(index, false)
      gridFocusedRef.current = true
      setGridFocused(true)
      pointerFocusPendingRef.current = true
      try {
        event.currentTarget.focus()
      } finally {
        pointerFocusPendingRef.current = false
      }
      setTooltipVisibility(true)
    },
    [
      cells,
      clearTooltipCloseTimer,
      clearTooltipOpenTimer,
      geometry,
      interactive,
      setActive,
      setInteractionMode,
      setTooltipVisibility,
    ]
  )

  const handleFocus = useCallback(() => {
    if (!interactive) return
    gridFocusedRef.current = true
    setGridFocused(true)
    if (pointerFocusPendingRef.current) return
    activateKeyboardMode()
    if (activeIndex === null) {
      setActive(defaultActivityActiveIndex(cells), true)
    }
    setTooltipVisibility(true)
  }, [
    activeIndex,
    activateKeyboardMode,
    cells,
    interactive,
    setActive,
    setTooltipVisibility,
  ])

  const handleBlur = useCallback(() => {
    clearPointerTooltip(true)
    pointerFocusPendingRef.current = false
    gridFocusedRef.current = false
    setGridFocused(false)
    setInteractionMode('pointer')
    setTooltipVisibility(false)
  }, [clearPointerTooltip, setInteractionMode, setTooltipVisibility])

  const handlePointerCancel = useCallback(() => {
    setInteractionMode('pointer')
    clearPointerTooltip(true)
    gridFocusedRef.current = false
    setGridFocused(false)
    setTooltipVisibility(false)
    containerRef.current?.blur()
  }, [clearPointerTooltip, setInteractionMode, setTooltipVisibility])

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (!interactive) return
      if (event.key === 'Escape') {
        event.preventDefault()
        if (interactionModeRef.current === 'pointer') {
          clearPointerTooltip(true)
        } else {
          setTooltipVisibility(false)
        }
        return
      }
      const key = navigationKey(event.key)
      if (!key) return
      event.preventDefault()
      activateKeyboardMode()
      const current = activeIndex ?? defaultActivityActiveIndex(cells)
      if (current === null) return
      const next = moveActivityActiveIndex(cells, current, key, {
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
      })
      setActive(next, false)
      setTooltipVisibility(true)
    },
    [
      activeIndex,
      activateKeyboardMode,
      cells,
      clearPointerTooltip,
      interactive,
      setActive,
      setTooltipVisibility,
    ]
  )

  const handleTooltipOpenChange = useCallback(
    (open: boolean, eventDetails: TooltipRootChangeEventDetails) => {
      const focusOwnsCurrentTooltip =
        gridFocusedRef.current && interactionModeRef.current !== 'pointer'
      const eventTarget = eventDetails.event?.target
      if (
        !open &&
        eventDetails.reason === 'outside-press' &&
        eventTarget instanceof Node &&
        containerRef.current?.contains(eventTarget)
      ) {
        eventDetails.cancel()
        return
      }
      if (
        open &&
        !focusOwnsCurrentTooltip &&
        pointerTargetDateKeyRef.current === null
      ) {
        return
      }
      if (!open) {
        clearTooltipOpenTimer()
        clearTooltipCloseTimer()
        tooltipWarmUntilRef.current = 0
        if (!focusOwnsCurrentTooltip) {
          pointerTargetDateKeyRef.current = null
          hoveredDateKeyRef.current = null
          setHoveredIndex(null)
        }
      }
      setTooltipVisibility(open)
    },
    [clearTooltipCloseTimer, clearTooltipOpenTimer, setTooltipVisibility]
  )

  const activeCell = activeIndex === null ? null : (cells[activeIndex] ?? null)
  const activeAriaRowIndex =
    activeIndex === null ? undefined : (activeIndex % 7) + 1
  const activeAriaColIndex =
    activeIndex === null ? undefined : Math.floor(activeIndex / 7) + 1
  const activePosition =
    geometry && activeIndex !== null
      ? cellPosition(geometry, activeIndex)
      : null
  const tooltipPosition =
    geometry && tooltipIndex !== null
      ? cellPosition(geometry, tooltipIndex)
      : null
  // Tooltip text changes width while the pointer crosses cells. A fresh
  // virtual anchor makes each React commit reposition explicitly, so Base UI
  // does not need an element ResizeObserver on this high-frequency path.
  const tooltipAnchor =
    tooltipCell && tooltipPosition
      ? {
          contextElement: containerRef.current ?? undefined,
          getBoundingClientRect: () =>
            tooltipAnchorRef.current?.getBoundingClientRect() ?? new DOMRect(),
        }
      : null
  const monthLabels = useMemo(() => activityMonthLabels(cells), [cells])
  const tooltipDetails = tooltipCell
    ? [
        tooltipCell.tracking !== 'untracked' && tooltipCell.submitted > 0
          ? t(`${KEY_ROOT}.tooltip.submitted`, {
              count: tooltipCell.submitted,
            })
          : null,
        tooltipCell.tracking !== 'untracked' &&
        tooltipCell.recoveredDownloadCompleted > 0
          ? t(`${KEY_ROOT}.tooltip.recoveredCount`, {
              count: tooltipCell.recoveredDownloadCompleted,
            })
          : null,
        tooltipCell.tracking === 'partial'
          ? t(`${KEY_ROOT}.tooltip.partialShort`)
          : null,
        tooltipCell.coverageDegraded
          ? t(`${KEY_ROOT}.tooltip.coverageShort`)
          : null,
      ].filter((detail): detail is string => detail !== null)
    : []
  const weekdayLabels = [
    { key: 'mon', index: 1 },
    { key: 'wed', index: 3 },
    { key: 'fri', index: 5 },
  ] as const

  return (
    <Tooltip
      disableHoverablePopup
      triggerId={tooltipTriggerId}
      open={
        interactive &&
        tooltipOpen &&
        tooltipCell !== null &&
        tooltipPosition !== null
      }
      onOpenChange={handleTooltipOpenChange}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: A Canvas-backed virtual grid cannot use a native table without duplicating every day in the DOM. */}
      <div
        ref={containerRef}
        data-testid="activity-calendar"
        dir="ltr"
        role="grid"
        tabIndex={interactive ? 0 : -1}
        aria-label={t(`${KEY_ROOT}.completedIntensity`)}
        aria-describedby={summaryId}
        aria-rowcount={7}
        aria-colcount={geometry?.weeks ?? maxWeeks}
        aria-activedescendant={interactive && activeCell ? cellId : undefined}
        aria-disabled={interactive ? undefined : true}
        className={cn(
          'relative isolate block h-full w-full overflow-hidden outline-none',
          CALENDAR_MIN_HEIGHT_CLASS,
          className
        )}
        onPointerEnter={handlePointerEnter}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        onPointerDown={handlePointerDown}
        onPointerCancel={handlePointerCancel}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      >
        {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: The Canvas is pixels-only; the focusable wrapper and virtual cell expose the complete accessible model. */}
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          data-testid="activity-canvas"
          className="absolute inset-0 block"
        />

        {geometry?.showMonthLabels
          ? monthLabels.map((label) => {
              const column = Math.floor(label.cellIndex / 7)
              return (
                <span
                  key={label.cellIndex}
                  aria-hidden="true"
                  className="pointer-events-none absolute top-0 truncate text-[10px] leading-3 text-muted-foreground"
                  style={{
                    left: geometry.gridLeft + column * geometry.stride,
                    maxWidth: Math.max(geometry.stride * 4, geometry.cellSize),
                  }}
                >
                  {monthFormatter.format(label.dateMs)}
                </span>
              )
            })
          : null}

        {geometry?.showWeekdayLabels
          ? weekdayLabels.map(({ key, index }) => (
              <span
                key={key}
                aria-hidden="true"
                className="pointer-events-none absolute start-0 w-6 truncate text-[10px] leading-none text-muted-foreground"
                style={{
                  top:
                    geometry.gridTop +
                    index * geometry.stride +
                    Math.max(
                      0,
                      Math.floor((geometry.cellSize - LABEL_FONT_SIZE) / 2)
                    ),
                }}
              >
                {t(`${KEY_ROOT}.weekday.${key}`)}
              </span>
            ))
          : null}

        {geometry?.showLegend ? (
          <div
            role="img"
            aria-label={t(`${KEY_ROOT}.completedIntensity`)}
            className="pointer-events-none absolute inset-x-0 bottom-0 flex h-4 items-center justify-end gap-1 text-[10px] text-muted-foreground"
          >
            <span>{t(`${KEY_ROOT}.less`)}</span>
            {[0, 1, 2, 3, 4].map((depth) => (
              <span
                key={depth}
                aria-hidden="true"
                className="rounded-[2px]"
                style={{
                  width: geometry.cellSize,
                  height: geometry.cellSize,
                  backgroundColor:
                    depth === 0
                      ? 'var(--muted)'
                      : `hsl(var(--chart-1) / ${activityLevelOpacity(
                          depth,
                          resolvedTheme === 'dark'
                        )})`,
                }}
              />
            ))}
            <span>{t(`${KEY_ROOT}.more`)}</span>
          </div>
        ) : null}

        {gridFocused && activePosition && geometry ? (
          <span
            data-testid="activity-focus-overlay"
            aria-hidden="true"
            className="pointer-events-none absolute box-border rounded-[2px] border border-ring"
            style={{
              left: activePosition.left,
              top: activePosition.top,
              width: geometry.cellSize,
              height: geometry.cellSize,
            }}
          />
        ) : null}

        <TooltipTrigger
          disabled
          id={tooltipTriggerId}
          render={
            <span
              ref={tooltipAnchorRef}
              aria-hidden="true"
              tabIndex={-1}
              data-testid="activity-tooltip-anchor"
              className="pointer-events-none absolute"
              style={
                tooltipPosition && geometry
                  ? {
                      left: tooltipPosition.left,
                      top: tooltipPosition.top,
                      width: geometry.cellSize,
                      height: geometry.cellSize,
                    }
                  : {
                      left: 0,
                      top: 0,
                      width: 0,
                      height: 0,
                    }
              }
            />
          }
        />

        {activeCell ? (
          <>
            {/* biome-ignore lint/a11y/useSemanticElements lint/a11y/useFocusableInteractive: The virtual row must remain a direct owned descendant while DOM focus stays on the composite grid. */}
            <span role="row" aria-rowindex={activeAriaRowIndex}>
              {/* biome-ignore lint/a11y/useSemanticElements: A native td cannot exist outside a table, while this virtual cell is owned by the ARIA row above. */}
              <span
                id={cellId}
                role="gridcell"
                tabIndex={-1}
                aria-rowindex={activeAriaRowIndex}
                aria-colindex={activeAriaColIndex}
                aria-label={describeCell(activeCell)}
                className="sr-only"
              />
            </span>
          </>
        ) : null}

        <span id={summaryId} className="sr-only">
          {rangeSummary}
        </span>
      </div>

      {tooltipCell ? (
        <TooltipContent
          anchor={tooltipAnchor}
          disableAnchorTracking
          side="top"
          className="max-w-none animate-none px-3 py-2 transition-none data-open:animate-none data-closed:animate-none"
        >
          <div className="whitespace-nowrap text-xs leading-4">
            <div className="font-medium">
              {tooltipCell.tracking === 'untracked'
                ? t(`${KEY_ROOT}.tooltip.noDataOnDate`, {
                    date: dateFormatter.format(tooltipCell.fromMs),
                  })
                : t(`${KEY_ROOT}.tooltip.completedOnDate`, {
                    count: tooltipCell.downloadCompleted,
                    date: dateFormatter.format(tooltipCell.fromMs),
                  })}
            </div>
            {tooltipDetails.length > 0 ? (
              <div className="text-primary-foreground/70">
                {tooltipDetails.join(' · ')}
              </div>
            ) : null}
          </div>
        </TooltipContent>
      ) : null}
    </Tooltip>
  )
}
