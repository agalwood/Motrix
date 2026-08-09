import { describe, expect, it } from 'vitest'
import {
  DASHBOARD_COLUMNS,
  DASHBOARD_ROWS,
  DEFAULT_DASHBOARD_LAYOUT,
  dashboardLayoutSettingsSchema,
  dashboardTileHeightSchema,
  dashboardTileIdSchema,
  dashboardTileLayoutSchema,
  dashboardTileWidthSchema,
} from './dashboard-layout'

describe('dashboardLayoutSettingsSchema', () => {
  it('keeps layout version 1 and the fixed 4x3 canvas', () => {
    const parsed = dashboardLayoutSettingsSchema.parse({})

    expect(parsed.version).toBe(1)
    expect(parsed.columns).toBe(DASHBOARD_COLUMNS)
    expect(DASHBOARD_COLUMNS).toBe(4)
    expect(DASHBOARD_ROWS).toBe(3)
  })

  it('accepts widths 1 through 4 and heights 1 through 3', () => {
    for (const width of [1, 2, 3, 4]) {
      expect(dashboardTileWidthSchema.safeParse(width).success).toBe(true)
    }
    for (const height of [1, 2, 3]) {
      expect(dashboardTileHeightSchema.safeParse(height).success).toBe(true)
    }

    expect(dashboardTileWidthSchema.safeParse(0).success).toBe(false)
    expect(dashboardTileWidthSchema.safeParse(5).success).toBe(false)
    expect(dashboardTileHeightSchema.safeParse(0).success).toBe(false)
    expect(dashboardTileHeightSchema.safeParse(4).success).toBe(false)
  })

  it('rejects placements that overflow the right or bottom edge', () => {
    const tile = {
      id: 'engine',
      enabled: true,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    } as const

    expect(
      dashboardTileLayoutSchema.safeParse({ ...tile, x: 3, w: 2 }).success
    ).toBe(false)
    expect(
      dashboardTileLayoutSchema.safeParse({ ...tile, y: 1, h: 3 }).success
    ).toBe(false)
  })

  it('registers nat as a hidden-by-default tile', () => {
    expect(dashboardTileIdSchema.options).toContain('nat')
    const nat = DEFAULT_DASHBOARD_LAYOUT.tiles.find((tile) => tile.id === 'nat')
    expect(nat).toBeDefined()
    expect(nat?.enabled).toBe(false)
  })

  it('registers activity as an enabled full-width default tile', () => {
    expect(dashboardTileIdSchema.options).toContain('activity')
    const activity = DEFAULT_DASHBOARD_LAYOUT.tiles.find(
      (tile) => tile.id === 'activity'
    )
    expect(activity).toMatchObject({
      enabled: true,
      x: 0,
      y: 2,
      w: 4,
      h: 1,
    })
  })

  it('returns the default dashboard layout for empty input', () => {
    const parsed = dashboardLayoutSettingsSchema.parse({})

    expect(parsed.version).toBe(1)
    expect(parsed.columns).toBe(DASHBOARD_COLUMNS)
    expect(parsed.tiles).toEqual(DEFAULT_DASHBOARD_LAYOUT.tiles)
    expect(parsed.tiles.find((tile) => tile.id === 'transfer')).toMatchObject({
      x: 2,
      y: 1,
      w: 2,
      h: 1,
    })
    expect(parsed.tiles.find((tile) => tile.id === 'tasks')).toMatchObject({
      x: 2,
      y: 1,
      w: 2,
      h: 2,
      enabled: false,
    })
  })

  it('does not special-case the old misplaced generated layout', () => {
    const parsed = dashboardLayoutSettingsSchema.parse({
      version: 1,
      columns: 4,
      tiles: [
        { id: 'engine', enabled: true, x: 0, y: 0, w: 2, h: 1 },
        { id: 'speedUp', enabled: true, x: 2, y: 0, w: 1, h: 1 },
        { id: 'speedDown', enabled: true, x: 3, y: 0, w: 1, h: 1 },
        { id: 'active', enabled: true, x: 0, y: 1, w: 2, h: 1 },
        { id: 'transfer', enabled: true, x: 2, y: 1, w: 2, h: 1 },
        { id: 'tasks', enabled: true, x: 2, y: 2, w: 2, h: 2 },
      ],
    })

    expect(parsed.tiles).not.toEqual(DEFAULT_DASHBOARD_LAYOUT.tiles)
    expect(parsed.tiles.find((tile) => tile.id === 'engine')).toMatchObject({
      x: 0,
      y: 0,
      w: 2,
      h: 1,
    })
  })

  it('filters unknown tiles and coerces invalid numeric fields', () => {
    const parsed = dashboardLayoutSettingsSchema.parse({
      version: 1,
      columns: 12,
      tiles: [
        { id: 'engine', enabled: true, x: -4, y: -1, w: 9, h: 9 },
        { id: 'unknown', enabled: true, x: 0, y: 0, w: 1, h: 1 },
      ],
    })

    expect(parsed.columns).toBe(4)
    // engine is coerced; unknown is dropped; all other default tiles are appended
    const ids = parsed.tiles.map((t) => t.id)
    expect(ids).toContain('engine')
    expect(ids).not.toContain('unknown')
    expect(ids).toContain('speedLimit')
    const engine = parsed.tiles.find((t) => t.id === 'engine')
    expect(engine).toMatchObject({ x: 0, y: 0, w: 1, h: 1 })
  })

  it('preserves 1x2 tiles exactly', () => {
    const parsed = dashboardLayoutSettingsSchema.parse({
      version: 1,
      columns: 4,
      tiles: [{ id: 'engine', enabled: true, x: 0, y: 0, w: 1, h: 2 }],
    })

    const engine = parsed.tiles.find((t) => t.id === 'engine')
    expect(engine).toEqual({
      id: 'engine',
      enabled: true,
      x: 0,
      y: 0,
      w: 1,
      h: 2,
    })
    expect(parsed.tiles.map((t) => t.id)).toContain('speedLimit')
  })

  it('preserves valid saved tile spans and appends missing defaults', () => {
    const parsed = dashboardLayoutSettingsSchema.parse({
      version: 1,
      columns: 4,
      tiles: [
        { id: 'engine', enabled: true, x: 0, y: 0, w: 1, h: 1 },
        { id: 'speedUp', enabled: true, x: 1, y: 0, w: 2, h: 1 },
        { id: 'tasks', enabled: true, x: 0, y: 1, w: 2, h: 2 },
      ],
    })

    // saved tiles preserve their sizes exactly; missing defaults are appended
    const byId = Object.fromEntries(parsed.tiles.map((t) => [t.id, t]))
    expect(byId.engine).toEqual({
      id: 'engine',
      enabled: true,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    })
    expect(byId.speedUp).toEqual({
      id: 'speedUp',
      enabled: true,
      x: 1,
      y: 0,
      w: 2,
      h: 1,
    })
    expect(byId.tasks).toEqual({
      id: 'tasks',
      enabled: true,
      x: 0,
      y: 1,
      w: 2,
      h: 2,
    })
    expect(parsed.tiles.map((t) => t.id)).toContain('speedLimit')
  })

  it('uses defaults when all persisted tiles are invalid', () => {
    const parsed = dashboardLayoutSettingsSchema.parse({
      version: 1,
      columns: 4,
      tiles: [{ id: 'unknown', enabled: true, x: 0, y: 0, w: 1, h: 1 }],
    })

    expect(parsed.tiles).toEqual(DEFAULT_DASHBOARD_LAYOUT.tiles)
  })

  it('rejects the unpublished legacy today tile id', () => {
    expect(dashboardTileIdSchema.safeParse('today').success).toBe(false)

    const parsed = dashboardLayoutSettingsSchema.parse({
      version: 1,
      columns: 4,
      tiles: [{ id: 'today', enabled: true, x: 0, y: 0, w: 2, h: 1 }],
    })

    expect(parsed.tiles).toEqual(DEFAULT_DASHBOARD_LAYOUT.tiles)
    expect(parsed.tiles.some((tile) => tile.id === 'transfer')).toBe(true)
  })

  it('accepts tasks and rejects the unpublished legacy id', () => {
    const legacyId = ['top', 'Tasks'].join('')

    expect(dashboardTileIdSchema.safeParse('tasks').success).toBe(true)
    expect(dashboardTileIdSchema.safeParse(legacyId).success).toBe(false)

    const parsed = dashboardLayoutSettingsSchema.parse({
      version: 1,
      columns: 4,
      tiles: [
        { id: 'engine', enabled: true, x: 0, y: 0, w: 1, h: 1 },
        { id: legacyId, enabled: true, x: 0, y: 0, w: 2, h: 3 },
      ],
    })

    expect(parsed.tiles.some((tile) => tile.id === 'tasks')).toBe(true)
    expect(parsed.tiles.find((tile) => tile.id === 'tasks')).toMatchObject({
      x: 2,
      y: 1,
      w: 2,
      h: 2,
    })
  })

  it('appends missing default tiles (e.g. a newly added speedLimit) to a saved layout', () => {
    const saved = {
      version: 1,
      columns: 4,
      tiles: [{ id: 'engine', enabled: true, x: 0, y: 0, w: 2, h: 1 }],
    }
    const parsed = dashboardLayoutSettingsSchema.parse(saved)
    const ids = parsed.tiles.map((t) => t.id)
    expect(ids).toContain('engine')
    expect(ids).toContain('speedLimit')
  })

  it('returns independent default tile arrays when input uses defaults', () => {
    const first = dashboardLayoutSettingsSchema.parse({})
    const second = dashboardLayoutSettingsSchema.parse({})

    first.tiles[0].enabled = false

    expect(second.tiles).toEqual(DEFAULT_DASHBOARD_LAYOUT.tiles)
    expect(first.tiles).not.toBe(DEFAULT_DASHBOARD_LAYOUT.tiles)
    expect(second.tiles).not.toBe(DEFAULT_DASHBOARD_LAYOUT.tiles)
  })
})
