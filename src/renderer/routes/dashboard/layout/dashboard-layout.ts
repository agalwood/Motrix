import {
  DASHBOARD_COLUMNS,
  DASHBOARD_ROWS,
  DEFAULT_DASHBOARD_LAYOUT,
  dashboardTileIdSchema,
} from '@shared/schemas/dashboard-layout'
import type {
  DashboardTileId,
  DashboardTileLayout,
  DashboardTileSpan,
} from '@shared/types/settings'
import {
  getDashboardTilePresentation,
  getDashboardTilePresentations,
  normalizeDashboardTilePresentation,
} from './dashboard-registry'

export type DashboardLayoutFailureReason =
  | 'unsupported-span'
  | 'out-of-bounds'
  | 'insufficient-space'

export type DashboardLayoutMutationResult =
  | {
      ok: true
      tiles: DashboardTileLayout[]
    }
  | {
      ok: false
      reason: DashboardLayoutFailureReason
    }

export interface DashboardTileSizeOption {
  presentation: ReturnType<typeof getDashboardTilePresentations>[number]
  available: boolean
  failureReason?: DashboardLayoutFailureReason
}

interface IndexedTile {
  tile: DashboardTileLayout
  previousIndex: number
}

export function maxTileBottom(tiles: DashboardTileLayout[]): number {
  return tiles.reduce((max, tile) => Math.max(max, tile.y + tile.h), 0)
}

export function collides(
  a: DashboardTileLayout,
  b: DashboardTileLayout
): boolean {
  if (!a.enabled || !b.enabled || a.id === b.id) return false
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  )
}

function isInsideDashboard(tile: DashboardTileLayout): boolean {
  return (
    Number.isInteger(tile.x) &&
    Number.isInteger(tile.y) &&
    tile.x >= 0 &&
    tile.y >= 0 &&
    tile.x + tile.w <= DASHBOARD_COLUMNS &&
    tile.y + tile.h <= DASHBOARD_ROWS
  )
}

function isFree(
  placed: DashboardTileLayout[],
  candidate: DashboardTileLayout
): boolean {
  return (
    isInsideDashboard(candidate) &&
    !placed.some((tile) => collides(tile, candidate))
  )
}

function firstFreeSlot(
  placed: DashboardTileLayout[],
  tile: DashboardTileLayout
): DashboardTileLayout | null {
  for (let y = 0; y <= DASHBOARD_ROWS - tile.h; y += 1) {
    for (let x = 0; x <= DASHBOARD_COLUMNS - tile.w; x += 1) {
      const candidate = { ...tile, x, y }
      if (isFree(placed, candidate)) return candidate
    }
  }
  return null
}

export function canonicalizeDashboardTileOrder(
  tiles: DashboardTileLayout[]
): DashboardTileLayout[] {
  const indexed = tiles.map((tile, previousIndex) => ({
    tile: { ...tile },
    previousIndex,
  }))
  const enabled = indexed
    .filter(({ tile }) => tile.enabled)
    .toSorted(
      (a, b) =>
        a.tile.y - b.tile.y ||
        a.tile.x - b.tile.x ||
        a.previousIndex - b.previousIndex
    )
  const disabled = indexed.filter(({ tile }) => !tile.enabled)

  return [...enabled, ...disabled].map(({ tile }) => tile)
}

function tryPackDashboardLayout(
  tiles: DashboardTileLayout[],
  pinnedId?: DashboardTileId
): DashboardTileLayout[] | null {
  const indexed = tiles.map<IndexedTile>((tile, previousIndex) => ({
    tile: { ...tile },
    previousIndex,
  }))
  const enabled = indexed.filter(({ tile }) => tile.enabled)
  const pinned = pinnedId
    ? enabled.find(({ tile }) => tile.id === pinnedId)
    : undefined

  if (pinned && !isInsideDashboard(pinned.tile)) return null

  const rest = enabled
    .filter(({ tile }) => tile.id !== pinnedId)
    .toSorted(
      (a, b) =>
        a.tile.y - b.tile.y ||
        a.tile.x - b.tile.x ||
        a.previousIndex - b.previousIndex
    )
  const placed: DashboardTileLayout[] = pinned ? [{ ...pinned.tile }] : []

  for (const { tile } of rest) {
    const resolved = isFree(placed, tile)
      ? { ...tile }
      : firstFreeSlot(placed, tile)
    if (!resolved) return null
    placed.push(resolved)
  }

  const placedById = new Map(placed.map((tile) => [tile.id, tile]))
  const packed = indexed.map(({ tile }) =>
    tile.enabled ? { ...(placedById.get(tile.id) ?? tile) } : { ...tile }
  )

  return canonicalizeDashboardTileOrder(packed)
}

function cloneDefaultTiles(): DashboardTileLayout[] {
  return DEFAULT_DASHBOARD_LAYOUT.tiles.map((tile) => ({ ...tile }))
}

function clampInsideDashboard(tile: DashboardTileLayout): DashboardTileLayout {
  return {
    ...tile,
    x: Math.min(Math.max(0, tile.x), DASHBOARD_COLUMNS - tile.w),
    y: Math.min(Math.max(0, tile.y), DASHBOARD_ROWS - tile.h),
  }
}

function mergeKnownTiles(tiles: DashboardTileLayout[]): DashboardTileLayout[] {
  const knownIds = new Set<DashboardTileId>(dashboardTileIdSchema.options)
  const seen = new Set<DashboardTileId>()
  const merged: DashboardTileLayout[] = []

  for (const tile of tiles) {
    if (!knownIds.has(tile.id) || seen.has(tile.id)) continue
    const presentation = normalizeDashboardTilePresentation(tile.id, tile)
    const normalized = {
      ...tile,
      ...presentation.span,
    }
    // Disabled tiles reserve no cells, so the packer intentionally leaves
    // them alone. Clamp invalid development geometry here after presentation
    // normalization so the returned complete layout still fits the 4x3
    // persisted canvas.
    merged.push(
      normalized.enabled ? normalized : clampInsideDashboard(normalized)
    )
    seen.add(tile.id)
  }

  for (const defaultTile of DEFAULT_DASHBOARD_LAYOUT.tiles) {
    if (seen.has(defaultTile.id)) continue
    merged.push({ ...defaultTile })
  }

  return merged
}

export function normalizeDashboardLayout(
  tiles: DashboardTileLayout[]
): DashboardTileLayout[] {
  const merged = mergeKnownTiles(tiles)
  return tryPackDashboardLayout(merged) ?? cloneDefaultTiles()
}

function successful(
  tiles: DashboardTileLayout[]
): DashboardLayoutMutationResult {
  return {
    ok: true,
    tiles: canonicalizeDashboardTileOrder(tiles),
  }
}

function failed(
  reason: DashboardLayoutFailureReason
): DashboardLayoutMutationResult {
  return { ok: false, reason }
}

export function moveTile(
  tiles: DashboardTileLayout[],
  id: DashboardTileId,
  target: { x: number; y: number }
): DashboardLayoutMutationResult {
  const current = tiles.find((tile) => tile.id === id)
  if (!current) return failed('insufficient-space')

  const moved = { ...current, ...target }
  if (!isInsideDashboard(moved)) return failed('out-of-bounds')

  const next = tiles.map((tile) => (tile.id === id ? moved : { ...tile }))
  if (!moved.enabled) return successful(next)

  const packed = tryPackDashboardLayout(next, id)
  return packed ? successful(packed) : failed('insufficient-space')
}

export function resizeTile(
  tiles: DashboardTileLayout[],
  id: DashboardTileId,
  span: DashboardTileSpan
): DashboardLayoutMutationResult {
  const current = tiles.find((tile) => tile.id === id)
  if (!current) return failed('insufficient-space')
  if (!getDashboardTilePresentation(id, span)) {
    return failed('unsupported-span')
  }

  const resized = { ...current, ...span }
  if (!isInsideDashboard(resized)) return failed('out-of-bounds')

  const next = tiles.map((tile) => (tile.id === id ? resized : { ...tile }))
  if (!resized.enabled) return successful(next)

  const packed = tryPackDashboardLayout(next, id)
  return packed ? successful(packed) : failed('insufficient-space')
}

export function setTileEnabled(
  tiles: DashboardTileLayout[],
  id: DashboardTileId,
  enabled: boolean
): DashboardLayoutMutationResult {
  const current = tiles.find((tile) => tile.id === id)
  if (!current) return failed('insufficient-space')

  if (!enabled) {
    return successful(
      tiles.map((tile) =>
        tile.id === id ? { ...tile, enabled: false } : { ...tile }
      )
    )
  }

  if (current.enabled) return successful(tiles)
  if (!getDashboardTilePresentation(id, current)) {
    return failed('unsupported-span')
  }

  const visible = tiles
    .filter((tile) => tile.enabled && tile.id !== id)
    .map((tile) => ({ ...tile }))
  const candidate = { ...current, enabled: true }
  const placed = isFree(visible, candidate)
    ? candidate
    : firstFreeSlot(visible, candidate)
  if (!placed) return failed('insufficient-space')

  return successful(
    tiles.map((tile) => (tile.id === id ? placed : { ...tile }))
  )
}

export function canResizeDashboardTile(
  tiles: DashboardTileLayout[],
  id: DashboardTileId,
  span: DashboardTileSpan
): boolean {
  return resizeTile(tiles, id, span).ok
}

export function getDashboardTileSizeOptions(
  tiles: DashboardTileLayout[],
  id: DashboardTileId
): DashboardTileSizeOption[] {
  return getDashboardTilePresentations(id).map((presentation) => {
    const result = resizeTile(tiles, id, presentation.span)
    return result.ok
      ? {
          presentation,
          available: true,
        }
      : {
          presentation,
          available: false,
          failureReason: result.reason,
        }
  })
}
