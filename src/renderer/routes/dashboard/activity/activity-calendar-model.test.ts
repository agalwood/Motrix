import type { TaskActivitySnapshot } from '@shared/types/task-activity'
import { afterEach, describe, expect, it } from 'vitest'
import {
  activityDepth,
  activityMonthLabels,
  buildActivityCells,
  buildActivityDayBoundaries,
  defaultActivityActiveIndex,
  hitTestActivityCell,
  localDateKey,
  maxActivityWeeks,
  moveActivityActiveIndex,
  projectActivityCells,
  selectActivityGeometry,
} from './activity-calendar-model'

function snapshot(
  overrides: Partial<TaskActivitySnapshot> = {}
): TaskActivitySnapshot {
  return {
    generation: 'test-generation',
    revision: 1,
    coverage: {
      trackingStartedAt: new Date(2020, 0, 1).getTime(),
      coverageGapAt: null,
    },
    days: [],
    ...overrides,
  }
}

const originalTimezone = process.env.TZ

afterEach(() => {
  if (originalTimezone === undefined) {
    delete process.env.TZ
  } else {
    process.env.TZ = originalTimezone
  }
})

describe('activity calendar day model', () => {
  it('builds 53 Sunday-aligned weeks ending in the current week', () => {
    const now = new Date(2026, 6, 29, 12)
    const boundaries = buildActivityDayBoundaries(now)

    expect(boundaries).toHaveLength(371)
    expect(new Date(boundaries[0]?.fromMs ?? 0).getDay()).toBe(0)
    expect(boundaries.at(-1)?.dateKey).toBe('2026-08-01')
    expect(boundaries.some((day) => day.dateKey === '2024-02-29')).toBe(false)
  })

  it('includes leap day without UTC date parsing', () => {
    const boundaries = buildActivityDayBoundaries(new Date(2024, 2, 1, 12), 2)

    expect(boundaries.map((day) => day.dateKey)).toContain('2024-02-29')
    expect(localDateKey(new Date(2024, 1, 29, 23))).toBe('2024-02-29')
  })

  it('uses local calendar arithmetic across DST changes', () => {
    process.env.TZ = 'America/New_York'

    const spring = buildActivityDayBoundaries(new Date(2026, 2, 10, 12), 2)
    const fall = buildActivityDayBoundaries(new Date(2026, 10, 3, 12), 2)

    expect(
      spring.some((day) => day.toMs - day.fromMs === 23 * 60 * 60 * 1000)
    ).toBe(true)
    expect(
      fall.some((day) => day.toMs - day.fromMs === 25 * 60 * 60 * 1000)
    ).toBe(true)
  })

  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 2],
    [4, 3],
    [7, 3],
    [8, 4],
    [200, 4],
  ] as const)('maps %i completions to fixed depth %i', (count, depth) => {
    expect(activityDepth(count)).toBe(depth)
  })

  it('classifies untracked, partial, recovered, and degraded coverage', () => {
    const now = new Date(2026, 6, 29, 12)
    const boundaries = buildActivityDayBoundaries(now)
    const partial = boundaries.at(-5)
    const tracked = boundaries.at(-4)
    if (!partial || !tracked) throw new Error('Missing fixture boundary')

    const cells = buildActivityCells(
      snapshot({
        coverage: {
          trackingStartedAt: partial.fromMs + 60 * 60 * 1000,
          coverageGapAt: tracked.fromMs + 60 * 60 * 1000,
        },
        days: [
          {
            dateKey: partial.dateKey,
            submitted: 2,
            downloadCompleted: 0,
            recoveredDownloadCompleted: 0,
          },
          {
            dateKey: tracked.dateKey,
            submitted: 3,
            downloadCompleted: 8,
            recoveredDownloadCompleted: 1,
          },
        ],
      }),
      now
    )

    const partialCell = cells.find((cell) => cell.dateKey === partial.dateKey)
    const trackedCell = cells.find((cell) => cell.dateKey === tracked.dateKey)

    expect(cells[0]?.tracking).toBe('untracked')
    expect(partialCell).toMatchObject({
      tracking: 'partial',
      depth: 0,
      coverageDegraded: false,
    })
    expect(trackedCell).toMatchObject({
      tracking: 'tracked',
      depth: 4,
      recoveredDownloadCompleted: 1,
      coverageDegraded: true,
    })
    expect(cells.at(-1)?.tracking).toBe('future')
  })

  it('projects only trailing whole weeks', () => {
    const cells = buildActivityCells(snapshot(), new Date(2026, 6, 29, 12))

    const projected = projectActivityCells(cells, 13)
    expect(projected).toHaveLength(91)
    expect(projected[0]?.dateKey).toBe(cells.at(-91)?.dateKey)
    expect(projected.at(-1)?.dateKey).toBe(cells.at(-1)?.dateKey)
  })

  it('omits a short leading partial month that would overlap the next label', () => {
    const cells = buildActivityCells(snapshot(), new Date(2026, 7, 23, 12))
    const labels = activityMonthLabels(cells)

    expect(new Date(labels[0]?.dateMs ?? 0).getMonth()).toBe(8)
    expect(labels[0]?.cellIndex).toBe(7)
  })

  it('omits the duplicated trailing month label only in a full-year view', () => {
    const cells = buildActivityCells(snapshot(), new Date(2026, 6, 29, 12))
    const fullYearLabels = activityMonthLabels(cells)
    const firstMonth = new Date(fullYearLabels[0]?.dateMs ?? 0).getMonth()
    const lastMonth = new Date(fullYearLabels.at(-1)?.dateMs ?? 0).getMonth()

    expect(firstMonth).not.toBe(lastMonth)
    expect(fullYearLabels).toHaveLength(12)

    const quarterLabels = activityMonthLabels(projectActivityCells(cells, 13))
    expect(quarterLabels.length).toBeGreaterThan(1)
  })
})

describe('activity calendar geometry', () => {
  it('maps tile content levels to presentation maximums', () => {
    expect(maxActivityWeeks('compact')).toBe(13)
    expect(maxActivityWeeks('summary')).toBe(13)
    expect(maxActivityWeeks('detailed')).toBe(26)
    expect(maxActivityWeeks('focus')).toBe(53)
  })

  it('chooses the largest fitting standard presentation', () => {
    expect(
      selectActivityGeometry({
        width: 720,
        height: 130,
        contentLevel: 'focus',
      })?.weeks
    ).toBe(53)
    expect(
      selectActivityGeometry({
        width: 390,
        height: 100,
        contentLevel: 'focus',
      })?.weeks
    ).toBe(26)
    expect(
      selectActivityGeometry({
        width: 170,
        height: 80,
        contentLevel: 'focus',
      })?.weeks
    ).toBe(13)
  })

  it('never promotes beyond the tile presentation maximum', () => {
    const geometry = selectActivityGeometry({
      width: 900,
      height: 200,
      contentLevel: 'compact',
    })

    expect(geometry).toMatchObject({ weeks: 13, cellSize: 12 })
  })

  it('fits airy 9px cells in the 690x172 activity card budget', () => {
    const geometry = selectActivityGeometry({
      // TileShell leaves a 658x120 Calendar box after 16px card padding and
      // the compact 24px header with its -4px block-start margin.
      width: 658,
      height: 120,
      contentLevel: 'focus',
    })

    expect(geometry).toMatchObject({
      weeks: 53,
      cellSize: 9,
      gap: 3,
      showLegend: true,
      showMonthLabels: true,
      showWeekdayLabels: true,
      gridLeft: 24,
      gridTop: 17,
      gridWidth: 633,
      gridHeight: 81,
    })
    expect(
      (geometry?.gridLeft ?? 0) + (geometry?.gridWidth ?? 0)
    ).toBeLessThanOrEqual(658)
    expect(
      (geometry?.gridTop ?? 0) + (geometry?.gridHeight ?? 0)
    ).toBeLessThanOrEqual(102)

    expect(
      selectActivityGeometry({
        width: 657,
        height: 120,
        contentLevel: 'focus',
      })
    ).toMatchObject({
      weeks: 53,
      cellSize: 9,
      gap: 3,
      gridLeft: 24,
      gridWidth: 633,
    })
    expect(
      selectActivityGeometry({
        width: 656,
        height: 120,
        contentLevel: 'focus',
      })
    ).toMatchObject({
      weeks: 53,
      cellSize: 9,
      gap: 2,
    })
  })

  it('honors the exact standard-cell threshold before emergency sizing', () => {
    const spacious = selectActivityGeometry({
      width: 127,
      height: 70,
      contentLevel: 'compact',
    })
    const comfortable = selectActivityGeometry({
      width: 126,
      height: 70,
      contentLevel: 'compact',
    })
    const exact = selectActivityGeometry({
      width: 103,
      height: 55,
      contentLevel: 'compact',
    })
    const constrained = selectActivityGeometry({
      width: 102,
      height: 55,
      contentLevel: 'compact',
    })

    expect(spacious).toMatchObject({
      weeks: 13,
      cellSize: 7,
      gap: 3,
    })
    expect(comfortable).toMatchObject({
      weeks: 13,
      cellSize: 7,
      gap: 2,
    })
    expect(exact).toMatchObject({
      weeks: 13,
      cellSize: 7,
      gap: 1,
    })
    expect(constrained).toMatchObject({
      weeks: 13,
      cellSize: 6,
      gap: 1,
    })
  })

  it('preserves chrome once the preferred density fits shorter slots', () => {
    const full = selectActivityGeometry({
      width: 720,
      height: 90,
      contentLevel: 'focus',
    })
    const narrowAutoRow = selectActivityGeometry({
      width: 180,
      height: 56,
      contentLevel: 'detailed',
    })

    expect(full).toMatchObject({
      weeks: 53,
      cellSize: 9,
      gap: 2,
      showLegend: false,
      showMonthLabels: true,
      showWeekdayLabels: true,
    })
    expect(narrowAutoRow).toMatchObject({
      showLegend: false,
      showMonthLabels: false,
      showWeekdayLabels: true,
    })
  })

  it('restores chrome only when it does not shrink the grid stride', () => {
    const beforeThreshold = selectActivityGeometry({
      width: 658,
      height: 86,
      contentLevel: 'focus',
    })
    const afterThreshold = selectActivityGeometry({
      width: 658,
      height: 87,
      contentLevel: 'focus',
    })

    for (const geometry of [beforeThreshold, afterThreshold]) {
      expect(geometry).toMatchObject({
        weeks: 53,
        cellSize: 9,
        gap: 3,
        stride: 12,
        gridWidth: 633,
        showLegend: false,
        showMonthLabels: false,
        showWeekdayLabels: true,
      })
    }
  })

  it('uses a bounded whole-week emergency fallback below 13', () => {
    const geometry = selectActivityGeometry({
      width: 54,
      height: 48,
      contentLevel: 'compact',
    })

    expect(geometry).toMatchObject({
      weeks: 9,
      cellSize: 5,
      gap: 1,
    })
    expect(
      (geometry?.gridLeft ?? 0) + (geometry?.gridWidth ?? 0)
    ).toBeLessThanOrEqual(54)
    expect(
      (geometry?.gridTop ?? 0) + (geometry?.gridHeight ?? 0)
    ).toBeLessThanOrEqual(48)
  })

  it('returns no geometry until the measured box can contain one week', () => {
    expect(
      selectActivityGeometry({
        width: 4,
        height: 40,
        contentLevel: 'compact',
      })
    ).toBeNull()
  })

  it('hit tests cells directly and rejects gaps, bounds, and future cells', () => {
    const now = new Date(2026, 6, 29, 12)
    const cells = projectActivityCells(buildActivityCells(snapshot(), now), 13)
    const geometry = selectActivityGeometry({
      width: 170,
      height: 80,
      contentLevel: 'compact',
    })
    if (!geometry) throw new Error('Missing geometry')

    expect(
      hitTestActivityCell(
        geometry,
        cells,
        geometry.gridLeft + 1,
        geometry.gridTop + 1
      )
    ).toBe(0)
    expect(
      hitTestActivityCell(
        geometry,
        cells,
        geometry.gridLeft + geometry.cellSize,
        geometry.gridTop + 1
      )
    ).toBeNull()
    expect(
      hitTestActivityCell(geometry, cells, geometry.gridLeft - 1, 0)
    ).toBeNull()
    expect(
      hitTestActivityCell(
        geometry,
        cells,
        geometry.gridLeft + geometry.gridWidth - 1,
        geometry.gridTop + geometry.gridHeight - 1
      )
    ).toBeNull()
  })
})

describe('activity keyboard navigation', () => {
  const cells = projectActivityCells(
    buildActivityCells(snapshot(), new Date(2026, 6, 29, 12)),
    13
  )

  it('uses physical grid arrows without wrapping rows', () => {
    expect(moveActivityActiveIndex(cells, 8, 'ArrowLeft')).toBe(1)
    expect(moveActivityActiveIndex(cells, 8, 'ArrowRight')).toBe(15)
    expect(moveActivityActiveIndex(cells, 8, 'ArrowUp')).toBe(7)
    expect(moveActivityActiveIndex(cells, 8, 'ArrowDown')).toBe(9)
    expect(moveActivityActiveIndex(cells, 7, 'ArrowUp')).toBe(7)
    expect(moveActivityActiveIndex(cells, 13, 'ArrowDown')).toBe(13)
  })

  it('supports Home, End, range endpoints, and four-week paging', () => {
    const today = defaultActivityActiveIndex(cells)
    if (today === null) throw new Error('Missing active cell')
    const weekday = today % 7

    expect(moveActivityActiveIndex(cells, 36, 'Home')).toBe(1)
    expect(moveActivityActiveIndex(cells, 36, 'PageUp')).toBe(8)
    expect(moveActivityActiveIndex(cells, 8, 'PageDown')).toBe(36)
    expect(moveActivityActiveIndex(cells, 36, 'Home', { ctrlKey: true })).toBe(
      0
    )
    expect(moveActivityActiveIndex(cells, 36, 'End', { metaKey: true })).toBe(
      today
    )
    expect(moveActivityActiveIndex(cells, weekday, 'End') % 7).toBe(weekday)
  })

  it('does not move into future cells', () => {
    const today = defaultActivityActiveIndex(cells)
    if (today === null) throw new Error('Missing active cell')

    expect(moveActivityActiveIndex(cells, today, 'ArrowDown')).toBe(today)
    expect(moveActivityActiveIndex(cells, today, 'ArrowRight')).toBe(today)
  })
})
