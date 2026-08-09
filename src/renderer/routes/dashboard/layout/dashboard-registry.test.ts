import {
  DASHBOARD_COLUMNS,
  DASHBOARD_ROWS,
  DEFAULT_DASHBOARD_LAYOUT,
} from '@shared/schemas/dashboard-layout'
import type { DashboardTileId } from '@shared/types/settings'
import { describe, expect, it } from 'vitest'
import {
  DASHBOARD_TILE_DEFINITION_BY_ID,
  DASHBOARD_TILE_DEFINITIONS,
  dashboardTileOrientation,
  dashboardTileSizeLabel,
  dashboardTileSpanKey,
  dashboardTileViewport,
  getDashboardTileDefinition,
  getDashboardTilePresentation,
  getDashboardTilePresentations,
  nearestDashboardTilePresentation,
  normalizeDashboardTilePresentation,
} from './dashboard-registry'

const EXPECTED_PRESENTATIONS = {
  engine: [
    ['1x1', 'compact'],
    ['2x1', 'summary'],
    ['1x2', 'detailed'],
    ['2x2', 'detailed'],
  ],
  speedLimit: [
    ['1x1', 'compact'],
    ['2x1', 'summary'],
    ['1x2', 'detailed'],
    ['2x2', 'detailed'],
  ],
  speedUp: [
    ['1x1', 'compact'],
    ['2x1', 'summary'],
    ['3x1', 'detailed'],
    ['4x1', 'focus'],
    ['2x2', 'detailed'],
    ['3x2', 'focus'],
  ],
  speedDown: [
    ['1x1', 'compact'],
    ['2x1', 'summary'],
    ['3x1', 'detailed'],
    ['4x1', 'focus'],
    ['2x2', 'detailed'],
    ['3x2', 'focus'],
  ],
  active: [
    ['1x1', 'compact'],
    ['2x1', 'summary'],
    ['2x2', 'detailed'],
    ['4x1', 'focus'],
  ],
  transfer: [
    ['1x1', 'compact'],
    ['2x1', 'summary'],
    ['1x2', 'detailed'],
    ['2x2', 'detailed'],
    ['4x1', 'focus'],
  ],
  tasks: [
    ['2x1', 'summary'],
    ['2x2', 'detailed'],
    ['2x3', 'focus'],
    ['3x2', 'focus'],
    ['3x3', 'focus'],
    ['4x2', 'focus'],
  ],
  nat: [
    ['1x1', 'compact'],
    ['2x1', 'summary'],
    ['1x2', 'detailed'],
    ['2x2', 'detailed'],
    ['2x3', 'focus'],
  ],
  activity: [
    ['1x1', 'compact'],
    ['2x1', 'summary'],
    ['3x1', 'detailed'],
    ['4x1', 'focus'],
    ['2x2', 'detailed'],
    ['3x2', 'focus'],
    ['4x2', 'focus'],
  ],
} as const

function presentationPairs(id: DashboardTileId) {
  return getDashboardTilePresentations(id).map((presentation) => [
    dashboardTileSpanKey(presentation.span),
    presentation.contentLevel,
  ])
}

describe('dashboard-registry', () => {
  it('defines every known tile exactly once in default order', () => {
    const ids = DASHBOARD_TILE_DEFINITIONS.map((definition) => definition.id)

    expect(ids).toEqual(DEFAULT_DASHBOARD_LAYOUT.tiles.map((tile) => tile.id))
    expect(new Set(ids)).toHaveProperty('size', ids.length)
    expect(DASHBOARD_TILE_DEFINITION_BY_ID).toHaveProperty('size', ids.length)
  })

  it('matches the exact presentation capability matrix', () => {
    for (const [id, expected] of Object.entries(EXPECTED_PRESENTATIONS)) {
      expect(presentationPairs(id as DashboardTileId)).toEqual(expected)
    }
  })

  it('declares each shared default span as a supported presentation', () => {
    for (const tile of DEFAULT_DASHBOARD_LAYOUT.tiles) {
      const definition = getDashboardTileDefinition(tile.id)
      expect(definition.defaultSpan).toEqual({ w: tile.w, h: tile.h })
      expect(
        getDashboardTilePresentation(tile.id, definition.defaultSpan)
      ).toBeDefined()
    }
  })

  it('has no duplicate or out-of-canvas spans', () => {
    for (const definition of DASHBOARD_TILE_DEFINITIONS) {
      const keys = definition.presentations.map((presentation) =>
        dashboardTileSpanKey(presentation.span)
      )
      expect(new Set(keys)).toHaveProperty('size', keys.length)

      for (const presentation of definition.presentations) {
        expect(presentation.span.w).toBeLessThanOrEqual(DASHBOARD_COLUMNS)
        expect(presentation.span.h).toBeLessThanOrEqual(DASHBOARD_ROWS)
      }
    }
  })

  it('looks up only exact registered presentations', () => {
    expect(getDashboardTilePresentation('engine', { w: 1, h: 2 })).toEqual({
      span: { w: 1, h: 2 },
      contentLevel: 'detailed',
    })
    expect(
      getDashboardTilePresentation('engine', { w: 4, h: 3 })
    ).toBeUndefined()
  })

  it('derives square, wide, and tall orientations', () => {
    expect(dashboardTileOrientation({ w: 2, h: 2 })).toBe('square')
    expect(dashboardTileOrientation({ w: 3, h: 1 })).toBe('wide')
    expect(dashboardTileOrientation({ w: 1, h: 3 })).toBe('tall')
  })

  it('derives localized size-label concepts from presentations', () => {
    expect(
      dashboardTileSizeLabel({
        span: { w: 1, h: 1 },
        contentLevel: 'compact',
      })
    ).toBe('compact')
    expect(
      dashboardTileSizeLabel({
        span: { w: 3, h: 1 },
        contentLevel: 'detailed',
      })
    ).toBe('wide')
    expect(
      dashboardTileSizeLabel({
        span: { w: 1, h: 2 },
        contentLevel: 'detailed',
      })
    ).toBe('tall')
    expect(
      dashboardTileSizeLabel({
        span: { w: 2, h: 2 },
        contentLevel: 'detailed',
      })
    ).toBe('large')
    expect(
      dashboardTileSizeLabel({
        span: { w: 4, h: 1 },
        contentLevel: 'focus',
      })
    ).toBe('fullWidth')
    expect(
      dashboardTileSizeLabel({
        span: { w: 2, h: 3 },
        contentLevel: 'focus',
      })
    ).toBe('fullHeight')
  })

  it('normalizes by orientation, distance, area, then declaration order', () => {
    // Orientation wins even when the square candidate has a shorter distance.
    expect(
      normalizeDashboardTilePresentation('nat', { w: 4, h: 2 }).span
    ).toEqual({ w: 2, h: 1 })

    // Both candidates are one unit away; 3x2 has the closer area than 4x1.
    expect(
      normalizeDashboardTilePresentation('speedUp', { w: 4, h: 2 }).span
    ).toEqual({ w: 3, h: 2 })

    // 2x1 and 4x1 have equal orientation, distance, and area difference.
    expect(
      normalizeDashboardTilePresentation('active', { w: 3, h: 1 }).span
    ).toEqual({ w: 2, h: 1 })
  })

  it('keeps exact presentations when snapping pointer spans', () => {
    const exact = getDashboardTilePresentation('engine', { w: 1, h: 2 })

    expect(nearestDashboardTilePresentation('engine', { w: 1, h: 2 })).toBe(
      exact
    )
  })

  it('snaps representative 1x2, 3x1, 2x3, and 4x1 raw spans', () => {
    expect(
      nearestDashboardTilePresentation('tasks', { w: 1, h: 2 }).span
    ).toEqual({ w: 2, h: 2 })
    expect(
      nearestDashboardTilePresentation('active', { w: 3, h: 1 }).span
    ).toEqual({ w: 2, h: 1 })
    expect(
      nearestDashboardTilePresentation('active', { w: 2, h: 3 }).span
    ).toEqual({ w: 2, h: 2 })
    expect(
      nearestDashboardTilePresentation('tasks', { w: 4, h: 1 }).span
    ).toEqual({ w: 4, h: 2 })
  })

  it('uses area difference after Manhattan distance for pointer snapping', () => {
    // 3x2 and 4x1 are equally distant; 3x2 has the closer area.
    expect(
      nearestDashboardTilePresentation('speedUp', { w: 4, h: 2 }).span
    ).toEqual({ w: 3, h: 2 })
  })

  it('uses declaration order as the final pointer-snapping tie-breaker', () => {
    // 2x1 and 4x1 have equal distance and area difference.
    expect(
      nearestDashboardTilePresentation('active', { w: 3, h: 1 }).span
    ).toEqual({ w: 2, h: 1 })
  })

  it('snaps independently from persisted presentation normalization', () => {
    const rawSpan = { w: 3, h: 3 } as const

    expect(nearestDashboardTilePresentation('nat', rawSpan).span).toEqual({
      w: 2,
      h: 3,
    })
    expect(normalizeDashboardTilePresentation('nat', rawSpan).span).toEqual({
      w: 2,
      h: 2,
    })
  })

  it('keeps tall and full-height presentations distinct from squares', () => {
    expect(
      normalizeDashboardTilePresentation('engine', { w: 1, h: 2 }).span
    ).toEqual({ w: 1, h: 2 })
    expect(
      normalizeDashboardTilePresentation('tasks', { w: 2, h: 3 }).span
    ).toEqual({ w: 2, h: 3 })
  })

  it('builds a viewport from the selected presentation', () => {
    expect(dashboardTileViewport('engine', { w: 1, h: 2 })).toEqual({
      span: { w: 1, h: 2 },
      orientation: 'tall',
      contentLevel: 'detailed',
    })

    expect(dashboardTileViewport('active', { w: 3, h: 1 })).toEqual({
      span: { w: 2, h: 1 },
      orientation: 'wide',
      contentLevel: 'summary',
    })
  })
})
