import type {
  TaskActivityDayBoundary,
  TaskActivitySnapshot,
} from '@shared/types/task-activity'
import type { DashboardTileContentLevel } from '../layout/dashboard-registry'

export const ACTIVITY_CALENDAR_WEEKS = 53
export const ACTIVITY_CALENDAR_DAYS = ACTIVITY_CALENDAR_WEEKS * 7

const PREFERRED_CELL_SIZE = 9
const STANDARD_MIN_CELL_SIZE = 7
const EMERGENCY_MIN_CELL_SIZE = 5
const MAX_CELL_SIZE = 12
const WEEKDAY_LABEL_WIDTH = 24
const MONTH_LABEL_HEIGHT = 14
const LEGEND_HEIGHT = 18
const GAP_PREFERENCES = [3, 2, 1] as const

export type ActivityTrackingState =
  | 'future'
  | 'untracked'
  | 'partial'
  | 'tracked'

export interface ActivityCalendarCell {
  dateKey: string
  fromMs: number
  toMs: number
  submitted: number
  downloadCompleted: number
  recoveredDownloadCompleted: number
  depth: 0 | 1 | 2 | 3 | 4
  tracking: ActivityTrackingState
  coverageDegraded: boolean
  today: boolean
}

export interface ActivityCalendarChrome {
  showMonthLabels: boolean
  showWeekdayLabels: boolean
  showLegend: boolean
}

export interface ActivityCalendarGeometry extends ActivityCalendarChrome {
  width: number
  height: number
  weeks: number
  cellSize: number
  gap: 1 | 2 | 3
  stride: number
  gridLeft: number
  gridTop: number
  gridWidth: number
  gridHeight: number
}

export interface ActivityGeometryInput {
  width: number
  height: number
  contentLevel: DashboardTileContentLevel
}

export type ActivityNavigationKey =
  | 'ArrowLeft'
  | 'ArrowRight'
  | 'ArrowUp'
  | 'ArrowDown'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown'

export interface ActivityNavigationModifiers {
  ctrlKey?: boolean
  metaKey?: boolean
}

export interface ActivityMonthLabel {
  cellIndex: number
  dateMs: number
}

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

function addLocalDays(value: Date, days: number): Date {
  const result = new Date(value)
  result.setDate(result.getDate() + days)
  return result
}

export function localDateKey(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0')
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function buildActivityDayBoundaries(
  now: Date,
  weeks = ACTIVITY_CALENDAR_WEEKS
): TaskActivityDayBoundary[] {
  if (
    !Number.isInteger(weeks) ||
    weeks < 1 ||
    weeks > ACTIVITY_CALENDAR_WEEKS
  ) {
    throw new RangeError('Activity calendar weeks must be between 1 and 53')
  }

  const today = startOfLocalDay(now)
  const currentWeekStart = addLocalDays(today, -today.getDay())
  const firstDay = addLocalDays(currentWeekStart, -(weeks - 1) * 7)
  const boundaries: TaskActivityDayBoundary[] = []

  for (let offset = 0; offset < weeks * 7; offset += 1) {
    const from = addLocalDays(firstDay, offset)
    const to = addLocalDays(firstDay, offset + 1)
    boundaries.push({
      dateKey: localDateKey(from),
      fromMs: from.getTime(),
      toMs: to.getTime(),
    })
  }

  return boundaries
}

export function activityDepth(completed: number): 0 | 1 | 2 | 3 | 4 {
  if (completed <= 0) return 0
  if (completed === 1) return 1
  if (completed <= 3) return 2
  if (completed <= 7) return 3
  return 4
}

export function buildActivityCells(
  snapshot: TaskActivitySnapshot,
  now: Date
): ActivityCalendarCell[] {
  const boundaries = buildActivityDayBoundaries(now)
  const todayMs = startOfLocalDay(now).getTime()
  const dayByKey = new Map(snapshot.days.map((day) => [day.dateKey, day]))
  const trackingStartedAt = snapshot.coverage.trackingStartedAt
  const coverageGapAt = snapshot.coverage.coverageGapAt

  return boundaries.map((boundary) => {
    const day = dayByKey.get(boundary.dateKey)
    const submitted = day?.submitted ?? 0
    const downloadCompleted = day?.downloadCompleted ?? 0
    const recoveredDownloadCompleted = day?.recoveredDownloadCompleted ?? 0

    let tracking: ActivityTrackingState
    if (boundary.fromMs > todayMs) {
      tracking = 'future'
    } else if (trackingStartedAt >= boundary.toMs) {
      tracking = 'untracked'
    } else if (trackingStartedAt > boundary.fromMs) {
      tracking = 'partial'
    } else {
      tracking = 'tracked'
    }

    return {
      ...boundary,
      submitted,
      downloadCompleted,
      recoveredDownloadCompleted,
      depth: activityDepth(downloadCompleted),
      tracking,
      coverageDegraded: coverageGapAt !== null && coverageGapAt < boundary.toMs,
      today: boundary.fromMs === todayMs,
    }
  })
}

export function maxActivityWeeks(
  contentLevel: DashboardTileContentLevel
): 13 | 26 | 53 {
  switch (contentLevel) {
    case 'compact':
    case 'summary':
      return 13
    case 'detailed':
      return 26
    case 'focus':
      return 53
  }
}

export function projectActivityCells(
  cells: readonly ActivityCalendarCell[],
  weeks: number
): ActivityCalendarCell[] {
  const dayCount = Math.max(0, Math.floor(weeks)) * 7
  return cells.slice(Math.max(0, cells.length - dayCount))
}

function maximumChrome(
  contentLevel: DashboardTileContentLevel
): ActivityCalendarChrome {
  switch (contentLevel) {
    case 'compact':
      return {
        showMonthLabels: false,
        showWeekdayLabels: false,
        showLegend: false,
      }
    case 'summary':
      return {
        showMonthLabels: false,
        showWeekdayLabels: true,
        showLegend: false,
      }
    case 'detailed':
      return {
        showMonthLabels: true,
        showWeekdayLabels: true,
        showLegend: false,
      }
    case 'focus':
      return {
        showMonthLabels: true,
        showWeekdayLabels: true,
        showLegend: true,
      }
  }
}

function chromePlans(
  contentLevel: DashboardTileContentLevel
): ActivityCalendarChrome[] {
  const plans: ActivityCalendarChrome[] = [maximumChrome(contentLevel)]
  const current = { ...plans[0] }

  if (current.showLegend) {
    current.showLegend = false
    plans.push({ ...current })
  }
  if (current.showMonthLabels) {
    current.showMonthLabels = false
    plans.push({ ...current })
  }
  if (current.showWeekdayLabels) {
    current.showWeekdayLabels = false
    plans.push({ ...current })
  }

  return plans
}

function chromeScore(chrome: ActivityCalendarChrome): number {
  return (
    Number(chrome.showLegend) +
    Number(chrome.showMonthLabels) +
    Number(chrome.showWeekdayLabels)
  )
}

function hasPreferredDensity(geometry: ActivityCalendarGeometry): boolean {
  return geometry.cellSize >= PREFERRED_CELL_SIZE && geometry.gap >= 2
}

function isBetterStandardGeometry(
  candidate: ActivityCalendarGeometry,
  best: ActivityCalendarGeometry | null
): boolean {
  if (!best) return true

  const candidatePreferred = hasPreferredDensity(candidate)
  const bestPreferred = hasPreferredDensity(best)
  if (candidatePreferred !== bestPreferred) return candidatePreferred

  const candidateChrome = chromeScore(candidate)
  const bestChrome = chromeScore(best)
  if (candidateChrome !== bestChrome) return candidateChrome > bestChrome

  if (candidate.stride !== best.stride) return candidate.stride > best.stride
  return candidate.gap > best.gap
}

function fitGeometry(
  width: number,
  height: number,
  weeks: number,
  gap: 1 | 2 | 3,
  minimumCellSize: number,
  chrome: ActivityCalendarChrome
): ActivityCalendarGeometry | null {
  const labelWidth = chrome.showWeekdayLabels ? WEEKDAY_LABEL_WIDTH : 0
  const labelHeight = chrome.showMonthLabels ? MONTH_LABEL_HEIGHT : 0
  const legendHeight = chrome.showLegend ? LEGEND_HEIGHT : 0
  const availableWidth = width - labelWidth
  const availableHeight = height - labelHeight - legendHeight
  const widthCellSize = Math.floor((availableWidth - (weeks - 1) * gap) / weeks)
  const heightCellSize = Math.floor((availableHeight - 6 * gap) / 7)
  const cellSize = Math.min(MAX_CELL_SIZE, widthCellSize, heightCellSize)

  if (cellSize < minimumCellSize) return null

  const stride = cellSize + gap
  const gridWidth = weeks * cellSize + (weeks - 1) * gap
  const gridHeight = 7 * cellSize + 6 * gap
  const gridAreaHeight = height - labelHeight - legendHeight

  return {
    ...chrome,
    width,
    height,
    weeks,
    cellSize,
    gap,
    stride,
    gridLeft:
      labelWidth + Math.max(0, Math.floor((availableWidth - gridWidth) / 2)),
    gridTop:
      labelHeight + Math.max(0, Math.floor((gridAreaHeight - gridHeight) / 2)),
    gridWidth,
    gridHeight,
  }
}

export function selectActivityGeometry({
  width,
  height,
  contentLevel,
}: ActivityGeometryInput): ActivityCalendarGeometry | null {
  if (width <= 0 || height <= 0) return null

  const maxWeeks = maxActivityWeeks(contentLevel)
  const requestedWeeks = [53, 26, 13].filter((weeks) => weeks <= maxWeeks)
  const plans = chromePlans(contentLevel)

  for (const weeks of requestedWeeks) {
    let best: ActivityCalendarGeometry | null = null
    for (const chrome of plans) {
      for (const gap of GAP_PREFERENCES) {
        const candidate = fitGeometry(
          width,
          height,
          weeks,
          gap,
          STANDARD_MIN_CELL_SIZE,
          chrome
        )
        if (!candidate) continue

        if (isBetterStandardGeometry(candidate, best)) {
          best = candidate
        }
      }
    }
    if (best) return best
  }

  let best: ActivityCalendarGeometry | null = null
  for (const chrome of plans) {
    const labelWidth = chrome.showWeekdayLabels ? WEEKDAY_LABEL_WIDTH : 0
    const availableWidth = width - labelWidth
    const emergencyWeeks = Math.min(
      13,
      Math.floor((availableWidth + 1) / (EMERGENCY_MIN_CELL_SIZE + 1))
    )
    if (emergencyWeeks < 1) continue

    const candidate = fitGeometry(
      width,
      height,
      emergencyWeeks,
      1,
      EMERGENCY_MIN_CELL_SIZE,
      chrome
    )
    if (
      candidate &&
      (!best ||
        candidate.weeks > best.weeks ||
        (candidate.weeks === best.weeks &&
          chromeScore(candidate) > chromeScore(best)))
    ) {
      best = candidate
    }
  }

  return best
}

export function hitTestActivityCell(
  geometry: ActivityCalendarGeometry,
  cells: readonly ActivityCalendarCell[],
  x: number,
  y: number
): number | null {
  const localX = x - geometry.gridLeft
  const localY = y - geometry.gridTop
  if (localX < 0 || localY < 0) return null

  const column = Math.floor(localX / geometry.stride)
  const row = Math.floor(localY / geometry.stride)
  if (column >= geometry.weeks || row >= 7) return null
  if (
    localX - column * geometry.stride >= geometry.cellSize ||
    localY - row * geometry.stride >= geometry.cellSize
  ) {
    return null
  }

  const index = column * 7 + row
  return cells[index]?.tracking === 'future' ? null : index
}

export function defaultActivityActiveIndex(
  cells: readonly ActivityCalendarCell[]
): number | null {
  const today = cells.findIndex((cell) => cell.today)
  if (today >= 0) return today

  for (let index = cells.length - 1; index >= 0; index -= 1) {
    if (cells[index]?.tracking !== 'future') return index
  }
  return null
}

function lastSelectableInWeekday(
  cells: readonly ActivityCalendarCell[],
  weekday: number
): number {
  for (let index = cells.length - 7 + weekday; index >= weekday; index -= 7) {
    if (cells[index]?.tracking !== 'future') return index
  }
  return weekday
}

export function moveActivityActiveIndex(
  cells: readonly ActivityCalendarCell[],
  currentIndex: number,
  key: ActivityNavigationKey,
  modifiers: ActivityNavigationModifiers = {}
): number {
  if (cells.length === 0) return currentIndex

  const column = Math.floor(currentIndex / 7)
  const weekday = currentIndex % 7
  const lastColumn = Math.floor((cells.length - 1) / 7)
  let target = currentIndex

  switch (key) {
    case 'ArrowLeft':
      target = column > 0 ? currentIndex - 7 : currentIndex
      break
    case 'ArrowRight':
      target = column < lastColumn ? currentIndex + 7 : currentIndex
      break
    case 'ArrowUp':
      target = weekday > 0 ? currentIndex - 1 : currentIndex
      break
    case 'ArrowDown':
      target = weekday < 6 ? currentIndex + 1 : currentIndex
      break
    case 'PageUp':
      target = Math.max(weekday, currentIndex - 28)
      break
    case 'PageDown':
      target = Math.min(lastColumn * 7 + weekday, currentIndex + 28)
      break
    case 'Home':
      if (modifiers.ctrlKey || modifiers.metaKey) {
        const firstSelectable = cells.findIndex(
          (cell) => cell.tracking !== 'future'
        )
        target = firstSelectable >= 0 ? firstSelectable : currentIndex
      } else {
        target = weekday
      }
      break
    case 'End':
      target =
        modifiers.ctrlKey || modifiers.metaKey
          ? (defaultActivityActiveIndex(cells) ?? currentIndex)
          : lastSelectableInWeekday(cells, weekday)
      break
  }

  return cells[target]?.tracking === 'future' ? currentIndex : target
}

export function activityMonthLabels(
  cells: readonly ActivityCalendarCell[]
): ActivityMonthLabel[] {
  const labels: ActivityMonthLabel[] = []

  for (let column = 0; column < cells.length / 7; column += 1) {
    const start = column * 7
    const week = cells.slice(start, start + 7)
    const monthStart = week.find(
      (cell) => new Date(cell.fromMs).getDate() === 1
    )
    if (column === 0 || monthStart) {
      labels.push({
        cellIndex: start,
        dateMs: monthStart?.fromMs ?? week[0]?.fromMs ?? 0,
      })
    }
  }

  // A partial month with fewer than three visible week columns does not leave
  // enough room for both short labels, so prefer the next complete month.
  const leadingLabelIsPartial =
    labels[0] && new Date(labels[0].dateMs).getDate() !== 1

  if (leadingLabelIsPartial && labels[1] && labels[1].cellIndex <= 14) {
    labels.shift()
  }

  // A 53-week projection commonly begins and ends in the same named month
  // across adjacent years. Repeating that month at both edges reads like a
  // duplicate heading, so keep the leading label only for the full-year view.
  if (cells.length === ACTIVITY_CALENDAR_DAYS && labels.length > 1) {
    const first = labels[0]
    const last = labels.at(-1)
    if (
      first &&
      last &&
      new Date(first.dateMs).getMonth() === new Date(last.dateMs).getMonth()
    ) {
      labels.pop()
    }
  }

  return labels
}
