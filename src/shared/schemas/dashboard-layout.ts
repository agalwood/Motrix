import type {
  DashboardLayoutSettings,
  DashboardTileLayout,
} from '@shared/types/settings'
import { z } from 'zod'

export const DASHBOARD_COLUMNS = 4
export const DASHBOARD_ROWS = 3

export const dashboardTileIdSchema = z.enum([
  'engine',
  'speedUp',
  'speedDown',
  'active',
  'transfer',
  'tasks',
  'speedLimit',
  'nat',
  'activity',
])

export const dashboardTileWidthSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
])

export const dashboardTileHeightSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
])

function isInsideDashboard(
  tile: Pick<DashboardTileLayout, 'x' | 'y' | 'w' | 'h'>
): boolean {
  return (
    tile.x + tile.w <= DASHBOARD_COLUMNS && tile.y + tile.h <= DASHBOARD_ROWS
  )
}

export const dashboardTileLayoutSchema = z
  .object({
    id: dashboardTileIdSchema,
    enabled: z.boolean().catch(true),
    x: z.number().int().min(0).catch(0),
    y: z.number().int().min(0).catch(0),
    w: dashboardTileWidthSchema.catch(1),
    h: dashboardTileHeightSchema.catch(1),
  })
  .refine(isInsideDashboard, {
    message: 'Dashboard tile exceeds the fixed canvas',
  })

export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayoutSettings = {
  version: 1,
  columns: DASHBOARD_COLUMNS,
  tiles: [
    { id: 'engine', enabled: true, x: 0, y: 0, w: 1, h: 1 },
    { id: 'speedLimit', enabled: true, x: 1, y: 0, w: 1, h: 1 },
    { id: 'speedUp', enabled: true, x: 2, y: 0, w: 1, h: 1 },
    { id: 'speedDown', enabled: true, x: 3, y: 0, w: 1, h: 1 },
    { id: 'active', enabled: true, x: 0, y: 1, w: 2, h: 1 },
    { id: 'transfer', enabled: true, x: 2, y: 1, w: 2, h: 1 },
    { id: 'activity', enabled: true, x: 0, y: 2, w: 4, h: 1 },
    { id: 'tasks', enabled: false, x: 2, y: 1, w: 2, h: 2 },
    // Off by default — niche (BT users). Available via the "Add tile" picker.
    { id: 'nat', enabled: false, x: 0, y: 0, w: 1, h: 1 },
  ],
}

function cloneTiles(
  tiles: DashboardLayoutSettings['tiles']
): DashboardLayoutSettings['tiles'] {
  return tiles.map((tile) => ({ ...tile }))
}

function cloneLayout(layout: DashboardLayoutSettings): DashboardLayoutSettings {
  return {
    ...layout,
    tiles: cloneTiles(layout.tiles),
  }
}

function parseTiles(input: unknown): DashboardLayoutSettings['tiles'] {
  if (!Array.isArray(input)) return cloneTiles(DEFAULT_DASHBOARD_LAYOUT.tiles)
  const parsed = input.flatMap((item) => {
    const idResult = dashboardTileIdSchema.safeParse(
      item && typeof item === 'object' && 'id' in item ? item.id : undefined
    )
    if (!idResult.success) return []

    const defaultTile = DEFAULT_DASHBOARD_LAYOUT.tiles.find(
      (tile) => tile.id === idResult.data
    )
    if (!defaultTile) return []

    const result = z
      .object({
        id: z.literal(defaultTile.id),
        enabled: z.boolean().catch(defaultTile.enabled),
        x: z.number().int().min(0).catch(defaultTile.x),
        y: z.number().int().min(0).catch(defaultTile.y),
        w: dashboardTileWidthSchema.catch(defaultTile.w),
        h: dashboardTileHeightSchema.catch(defaultTile.h),
      })
      .refine(isInsideDashboard, {
        message: 'Dashboard tile exceeds the fixed canvas',
      })
      .safeParse(item)
    return result.success ? [result.data] : []
  })
  if (parsed.length === 0) return cloneTiles(DEFAULT_DASHBOARD_LAYOUT.tiles)
  const present = new Set(parsed.map((t) => t.id))
  for (const def of DEFAULT_DASHBOARD_LAYOUT.tiles) {
    if (!present.has(def.id)) parsed.push({ ...def })
  }
  return parsed
}

export const dashboardLayoutSettingsSchema = z
  .object({
    version: z.literal(1).catch(1),
    columns: z.literal(DASHBOARD_COLUMNS).catch(DASHBOARD_COLUMNS),
    tiles: z.unknown().transform(parseTiles),
  })
  .catch(DEFAULT_DASHBOARD_LAYOUT)
  .transform(cloneLayout)
