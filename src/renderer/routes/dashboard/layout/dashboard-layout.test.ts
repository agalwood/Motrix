import {
  DASHBOARD_ROWS,
  DEFAULT_DASHBOARD_LAYOUT,
  dashboardTileIdSchema,
} from '@shared/schemas/dashboard-layout'
import type { DashboardTileLayout } from '@shared/types/settings'
import { describe, expect, it } from 'vitest'
import {
  canonicalizeDashboardTileOrder,
  canResizeDashboardTile,
  collides,
  getDashboardTileSizeOptions,
  moveTile,
  normalizeDashboardLayout,
  resizeTile,
  setTileEnabled,
} from './dashboard-layout'

const disabledKnownTiles: DashboardTileLayout[] =
  DEFAULT_DASHBOARD_LAYOUT.tiles.map((tile) => ({
    ...tile,
    enabled: false,
  }))

const base: DashboardTileLayout[] = disabledKnownTiles.map((tile) => {
  switch (tile.id) {
    case 'engine':
      return { ...tile, enabled: true, x: 0, y: 0, w: 1, h: 1 }
    case 'speedUp':
      return { ...tile, enabled: true, x: 1, y: 0, w: 1, h: 1 }
    case 'speedDown':
      return { ...tile, enabled: true, x: 2, y: 0, w: 1, h: 1 }
    default:
      return tile
  }
})

// The shipped default layout IS the full canvas: its seven enabled tiles
// (1+1+1+1+2+2+4 = 12 cells) exactly tile 4x3, and `tasks` / `nat` are the two
// off-by-default tiles. Do not hand-roll a "full canvas" by flipping `enabled`
// on the defaults — `tasks` deliberately parks its saved 2x2 geometry on top of
// `transfer`, which is legal only while it stays disabled.
function fullCanvas(): DashboardTileLayout[] {
  return DEFAULT_DASHBOARD_LAYOUT.tiles.map((tile) => ({ ...tile }))
}

function enabledTiles(tiles: DashboardTileLayout[]): DashboardTileLayout[] {
  return tiles.filter((tile) => tile.enabled)
}

function occupiedCells(tiles: DashboardTileLayout[]): string[] {
  const cells: string[] = []
  for (const tile of enabledTiles(tiles)) {
    for (let y = tile.y; y < tile.y + tile.h; y += 1) {
      for (let x = tile.x; x < tile.x + tile.w; x += 1) {
        cells.push(`${x},${y}`)
      }
    }
  }
  return cells
}

function expectNoEnabledOverlaps(tiles: DashboardTileLayout[]): void {
  const enabled = enabledTiles(tiles)
  for (let index = 0; index < enabled.length; index += 1) {
    for (
      let otherIndex = index + 1;
      otherIndex < enabled.length;
      otherIndex += 1
    ) {
      expect(collides(enabled[index], enabled[otherIndex])).toBe(false)
    }
  }
}

function expectInsideFixedCanvas(tiles: DashboardTileLayout[]): void {
  for (const tile of enabledTiles(tiles)) {
    expect(tile.x).toBeGreaterThanOrEqual(0)
    expect(tile.y).toBeGreaterThanOrEqual(0)
    expect(tile.x + tile.w).toBeLessThanOrEqual(4)
    expect(tile.y + tile.h).toBeLessThanOrEqual(DASHBOARD_ROWS)
  }
}

describe('dashboard-layout engine', () => {
  it('keeps fixtures in sync with every known tile id', () => {
    expect(disabledKnownTiles.map((tile) => tile.id).toSorted()).toEqual(
      [...dashboardTileIdSchema.options].toSorted()
    )
  })

  it('keeps the full-canvas fixture saturated and overlap-free', () => {
    const tiles = fullCanvas()
    const cells = occupiedCells(tiles)

    expectInsideFixedCanvas(tiles)
    expectNoEnabledOverlaps(tiles)
    expect(enabledTiles(tiles)).toHaveLength(7)
    expect(new Set(cells).size).toBe(cells.length)
    expect(cells).toHaveLength(4 * DASHBOARD_ROWS)
  })

  it('detects rectangle collisions only for enabled tiles', () => {
    expect(collides(base[0], base[1])).toBe(false)
    expect(
      collides(base[0], {
        id: 'transfer',
        enabled: true,
        x: 0,
        y: 0,
        w: 2,
        h: 1,
      })
    ).toBe(true)
    expect(
      collides(base[0], {
        id: 'transfer',
        enabled: false,
        x: 0,
        y: 0,
        w: 2,
        h: 1,
      })
    ).toBe(false)
  })

  it('normalizes unsupported persisted spans deterministically', () => {
    const normalized = normalizeDashboardLayout([
      {
        id: 'engine',
        enabled: true,
        x: 0,
        y: 0,
        w: 3,
        h: 3,
      },
      ...disabledKnownTiles.filter((tile) => tile.id !== 'engine'),
    ])

    expect(normalized.find((tile) => tile.id === 'engine')).toMatchObject({
      w: 2,
      h: 2,
    })
  })

  it('keeps disabled normalized presentations inside the fixed canvas', () => {
    const normalized = normalizeDashboardLayout([
      {
        id: 'tasks',
        enabled: false,
        x: 3,
        y: 2,
        w: 1,
        h: 1,
      },
    ])

    expect(normalized.find((tile) => tile.id === 'tasks')).toEqual({
      id: 'tasks',
      enabled: false,
      x: 2,
      y: 1,
      w: 2,
      h: 2,
    })
  })

  it('normalizes invalid placement and fills missing known tiles', () => {
    const normalized = normalizeDashboardLayout([
      { id: 'engine', enabled: true, x: 9, y: -1, w: 2, h: 1 },
    ])

    expectInsideFixedCanvas(normalized)
    expectNoEnabledOverlaps(normalized)
    expect(normalized.map((tile) => tile.id)).toContain('nat')
  })

  it('canonicalizes enabled tiles by position and preserves disabled order', () => {
    const tiles = canonicalizeDashboardTileOrder([
      { id: 'nat', enabled: false, x: 0, y: 0, w: 1, h: 1 },
      { id: 'speedDown', enabled: true, x: 2, y: 0, w: 1, h: 1 },
      { id: 'transfer', enabled: false, x: 0, y: 1, w: 2, h: 1 },
      { id: 'engine', enabled: true, x: 0, y: 0, w: 1, h: 1 },
      { id: 'speedUp', enabled: true, x: 1, y: 0, w: 1, h: 1 },
    ])

    expect(tiles.map((tile) => tile.id)).toEqual([
      'engine',
      'speedUp',
      'speedDown',
      'nat',
      'transfer',
    ])
  })

  it('moves a pinned tile and returns the packed layout explicitly', () => {
    const result = moveTile(base, 'speedDown', { x: 0, y: 0 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tiles.find((tile) => tile.id === 'speedDown')).toMatchObject({
      x: 0,
      y: 0,
    })
    expect(result.tiles.map((tile) => tile.id).slice(0, 3)).toEqual([
      'speedDown',
      'engine',
      'speedUp',
    ])
    expectNoEnabledOverlaps(result.tiles)
  })

  it('keeps an empty lower row as a valid move target', () => {
    const result = moveTile(base, 'speedUp', { x: 0, y: 2 })

    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return
    expect(result.tiles.find((tile) => tile.id === 'speedUp')).toMatchObject({
      x: 0,
      y: 2,
    })
  })

  it('rejects an out-of-bounds move without changing the input', () => {
    const before = structuredClone(base)
    const result = moveTile(base, 'speedDown', { x: 99, y: -3 })

    expect(result).toEqual({ ok: false, reason: 'out-of-bounds' })
    expect(base).toEqual(before)
  })

  it('reports insufficient space without disabling an enabled tile', () => {
    const saturated = fullCanvas()
    const before = structuredClone(saturated)
    const result = moveTile(saturated, 'engine', { x: 2, y: 2 })

    expect(result).toEqual({ ok: false, reason: 'insufficient-space' })
    expect(saturated).toEqual(before)
    expect(enabledTiles(saturated)).toHaveLength(7)
  })

  it('rejects an unsupported resize before packing', () => {
    expect(resizeTile(base, 'engine', { w: 3, h: 1 })).toEqual({
      ok: false,
      reason: 'unsupported-span',
    })
  })

  it('preserves the top-left resize anchor and repacks collisions', () => {
    const result = resizeTile(base, 'engine', { w: 2, h: 1 })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tiles.find((tile) => tile.id === 'engine')).toMatchObject({
      x: 0,
      y: 0,
      w: 2,
      h: 1,
    })
    expectNoEnabledOverlaps(result.tiles)
  })

  it('rejects right and bottom resize overflow', () => {
    const rightEdge = base.map((tile) =>
      tile.id === 'engine' ? { ...tile, x: 3 } : tile
    )
    const bottomEdge = base.map((tile) =>
      tile.id === 'engine' ? { ...tile, x: 0, y: 2 } : tile
    )

    expect(resizeTile(rightEdge, 'engine', { w: 2, h: 1 })).toEqual({
      ok: false,
      reason: 'out-of-bounds',
    })
    expect(resizeTile(bottomEdge, 'engine', { w: 1, h: 2 })).toEqual({
      ok: false,
      reason: 'out-of-bounds',
    })
  })

  it('rejects expansion on a full canvas without mutating it', () => {
    const saturated = fullCanvas()
    const before = structuredClone(saturated)
    const result = resizeTile(saturated, 'engine', { w: 2, h: 2 })

    expect(result).toEqual({ ok: false, reason: 'insufficient-space' })
    expect(saturated).toEqual(before)
  })

  it('disables a tile while preserving its saved geometry', () => {
    const result = setTileEnabled(base, 'engine', false)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tiles.find((tile) => tile.id === 'engine')).toMatchObject({
      enabled: false,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    })
    // Canonicalization only reorders enabled tiles; the disabled group keeps
    // its input order, so derive the expectation from the fixture instead of
    // snapshotting DEFAULT_DASHBOARD_LAYOUT's array order.
    expect(
      result.tiles.filter((tile) => !tile.enabled).map((tile) => tile.id)
    ).toEqual(
      base
        .filter((tile) => tile.id === 'engine' || !tile.enabled)
        .map((tile) => tile.id)
    )
  })

  it('does not reserve cells for disabled tiles when enabling', () => {
    const result = setTileEnabled(
      [
        { id: 'engine', enabled: false, x: 0, y: 0, w: 2, h: 1 },
        { id: 'speedUp', enabled: true, x: 0, y: 0, w: 1, h: 1 },
        ...disabledKnownTiles.filter(
          (tile) => tile.id !== 'engine' && tile.id !== 'speedUp'
        ),
      ],
      'engine',
      true
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tiles.find((tile) => tile.id === 'engine')).toMatchObject({
      enabled: true,
      x: 1,
      y: 0,
    })
  })

  it('reports insufficient space instead of silently keeping a tile hidden', () => {
    const saturated = fullCanvas()
    const result = setTileEnabled(saturated, 'nat', true)

    expect(result).toEqual({ ok: false, reason: 'insufficient-space' })
    expect(saturated.find((tile) => tile.id === 'nat')?.enabled).toBe(false)
  })

  it('derives menu availability from the same resize mutation', () => {
    const options = getDashboardTileSizeOptions(base, 'engine')

    for (const option of options) {
      const result = resizeTile(base, 'engine', option.presentation.span)
      expect(option.available).toBe(result.ok)
      expect(
        canResizeDashboardTile(base, 'engine', option.presentation.span)
      ).toBe(result.ok)
      if (!result.ok) {
        expect(option.failureReason).toBe(result.reason)
      }
    }
  })
})
