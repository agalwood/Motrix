import {
  DASHBOARD_COLUMNS,
  DASHBOARD_ROWS,
  DEFAULT_DASHBOARD_LAYOUT,
} from '@shared/schemas/dashboard-layout'
import type {
  DashboardLayoutSettings,
  DashboardTileLayout,
} from '@shared/types/settings'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyDashboardPreset,
  DASHBOARD_LAYOUT_PRESET_BY_ID,
  DASHBOARD_LAYOUT_PRESETS,
  type DashboardLayoutPresetId,
  getDashboardLayoutPreset,
  matchDashboardPreset,
} from './dashboard-presets'
import {
  DASHBOARD_TILE_DEFINITIONS,
  getDashboardTilePresentation,
} from './dashboard-registry'

const { packDashboardLayoutMock } = vi.hoisted(() => ({
  packDashboardLayoutMock: vi.fn((tiles: DashboardTileLayout[]) => tiles),
}))

vi.mock('./dashboard-layout', () => ({
  packDashboardLayout: packDashboardLayoutMock,
}))

const EXPECTED_TILES: Record<DashboardLayoutPresetId, DashboardTileLayout[]> = {
  balanced: [
    { id: 'engine', enabled: true, x: 0, y: 0, w: 1, h: 1 },
    { id: 'speedLimit', enabled: true, x: 1, y: 0, w: 1, h: 1 },
    { id: 'speedUp', enabled: true, x: 2, y: 0, w: 1, h: 1 },
    { id: 'speedDown', enabled: true, x: 3, y: 0, w: 1, h: 1 },
    { id: 'active', enabled: true, x: 0, y: 1, w: 2, h: 1 },
    { id: 'transfer', enabled: true, x: 2, y: 1, w: 2, h: 1 },
    { id: 'activity', enabled: true, x: 0, y: 2, w: 4, h: 1 },
    { id: 'tasks', enabled: false, x: 2, y: 1, w: 2, h: 2 },
    { id: 'nat', enabled: false, x: 0, y: 0, w: 1, h: 1 },
  ],
  taskFocus: [
    { id: 'tasks', enabled: true, x: 0, y: 0, w: 2, h: 3 },
    { id: 'engine', enabled: true, x: 2, y: 0, w: 1, h: 1 },
    { id: 'speedLimit', enabled: true, x: 3, y: 0, w: 1, h: 1 },
    { id: 'speedUp', enabled: true, x: 2, y: 1, w: 1, h: 1 },
    { id: 'speedDown', enabled: true, x: 3, y: 1, w: 1, h: 1 },
    { id: 'active', enabled: true, x: 2, y: 2, w: 1, h: 1 },
    { id: 'transfer', enabled: true, x: 3, y: 2, w: 1, h: 1 },
    { id: 'nat', enabled: false, x: 0, y: 0, w: 1, h: 1 },
    { id: 'activity', enabled: false, x: 0, y: 0, w: 1, h: 1 },
  ],
  speedFocus: [
    { id: 'speedUp', enabled: true, x: 0, y: 0, w: 2, h: 1 },
    { id: 'speedDown', enabled: true, x: 2, y: 0, w: 2, h: 1 },
    { id: 'tasks', enabled: true, x: 0, y: 1, w: 2, h: 2 },
    { id: 'engine', enabled: true, x: 2, y: 1, w: 1, h: 1 },
    { id: 'speedLimit', enabled: true, x: 3, y: 1, w: 1, h: 1 },
    { id: 'active', enabled: true, x: 2, y: 2, w: 1, h: 1 },
    { id: 'transfer', enabled: true, x: 3, y: 2, w: 1, h: 1 },
    { id: 'nat', enabled: false, x: 0, y: 0, w: 1, h: 1 },
    { id: 'activity', enabled: false, x: 0, y: 0, w: 1, h: 1 },
  ],
  compact: [
    { id: 'engine', enabled: true, x: 0, y: 0, w: 2, h: 1 },
    { id: 'speedLimit', enabled: true, x: 2, y: 0, w: 2, h: 1 },
    { id: 'speedUp', enabled: true, x: 0, y: 1, w: 1, h: 1 },
    { id: 'speedDown', enabled: true, x: 1, y: 1, w: 1, h: 1 },
    { id: 'active', enabled: true, x: 2, y: 1, w: 1, h: 1 },
    { id: 'transfer', enabled: true, x: 3, y: 1, w: 1, h: 1 },
    { id: 'tasks', enabled: true, x: 0, y: 2, w: 2, h: 1 },
    { id: 'nat', enabled: true, x: 2, y: 2, w: 2, h: 1 },
    { id: 'activity', enabled: false, x: 0, y: 0, w: 1, h: 1 },
  ],
}

const PRESET_IDS = Object.keys(EXPECTED_TILES) as DashboardLayoutPresetId[]

const TILE_FIELD_MUTATIONS: {
  name: string
  mutate: (tile: DashboardTileLayout) => void
}[] = [
  {
    name: 'enabled',
    mutate: (tile) => {
      tile.enabled = !tile.enabled
    },
  },
  {
    name: 'x',
    mutate: (tile) => {
      tile.x += 1
    },
  },
  {
    name: 'y',
    mutate: (tile) => {
      tile.y += 1
    },
  },
  {
    name: 'w',
    mutate: (tile) => {
      tile.w = tile.w === 1 ? 2 : 1
    },
  },
  {
    name: 'h',
    mutate: (tile) => {
      tile.h = tile.h === 1 ? 2 : 1
    },
  },
]

function rectanglesOverlap(
  left: DashboardTileLayout,
  right: DashboardTileLayout
): boolean {
  return (
    left.x < right.x + right.w &&
    left.x + left.w > right.x &&
    left.y < right.y + right.h &&
    left.y + left.h > right.y
  )
}

function expectValidPreset(layout: DashboardLayoutSettings): void {
  const knownIds = DASHBOARD_TILE_DEFINITIONS.map(
    (definition) => definition.id
  ).toSorted()
  const actualIds = layout.tiles.map((tile) => tile.id)

  expect(actualIds.toSorted()).toEqual(knownIds)
  expect(new Set(actualIds).size).toBe(actualIds.length)

  for (const tile of layout.tiles) {
    expect(tile.x).toBeGreaterThanOrEqual(0)
    expect(tile.y).toBeGreaterThanOrEqual(0)
    expect(tile.x + tile.w).toBeLessThanOrEqual(DASHBOARD_COLUMNS)
    expect(tile.y + tile.h).toBeLessThanOrEqual(DASHBOARD_ROWS)
    const presentation = getDashboardTilePresentation(tile.id, tile)
    expect(presentation).toBeDefined()
    expect(presentation).not.toBeNull()
  }

  const enabled = layout.tiles.filter((tile) => tile.enabled)
  for (let leftIndex = 0; leftIndex < enabled.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < enabled.length;
      rightIndex += 1
    ) {
      expect(rectanglesOverlap(enabled[leftIndex], enabled[rightIndex])).toBe(
        false
      )
    }
  }

  expect(enabled).toEqual(
    enabled.toSorted((left, right) => left.y - right.y || left.x - right.x)
  )
  expect(
    layout.tiles.slice(enabled.length).every((tile) => !tile.enabled)
  ).toBe(true)
}

describe('dashboard layout presets', () => {
  beforeEach(() => {
    packDashboardLayoutMock.mockClear()
  })

  it.each(PRESET_IDS)('defines the exact ordered %s table', (id) => {
    expect(getDashboardLayoutPreset(id).layout).toEqual({
      version: 1,
      columns: DASHBOARD_COLUMNS,
      tiles: EXPECTED_TILES[id],
    })
  })

  it('exports all four presets in their canonical menu order', () => {
    expect(DASHBOARD_LAYOUT_PRESETS.map((preset) => preset.id)).toEqual([
      'balanced',
      'taskFocus',
      'speedFocus',
      'compact',
    ])

    for (const preset of DASHBOARD_LAYOUT_PRESETS) {
      expect(DASHBOARD_LAYOUT_PRESET_BY_ID.get(preset.id)).toBe(preset)
      expect(getDashboardLayoutPreset(preset.id)).toBe(preset)
    }
  })

  it.each(PRESET_IDS)(
    'keeps %s complete, supported, ordered, and inside the fixed canvas',
    (id) => {
      expectValidPreset(getDashboardLayoutPreset(id).layout)
    }
  )

  it('keeps Balanced identical to the shared default layout', () => {
    expect(getDashboardLayoutPreset('balanced').layout).toEqual(
      DEFAULT_DASHBOARD_LAYOUT
    )
  })

  it('applies a preset as a deep clone', () => {
    const first = applyDashboardPreset('compact')
    const second = applyDashboardPreset('compact')
    const template = getDashboardLayoutPreset('compact').layout

    expect(first).toEqual(template)
    expect(first).not.toBe(template)
    expect(first.tiles).not.toBe(template.tiles)
    expect(first.tiles[0]).not.toBe(template.tiles[0])
    expect(second).not.toBe(first)
    expect(second.tiles[0]).not.toBe(first.tiles[0])

    first.tiles[0].enabled = false
    first.tiles[0].x = 3

    expect(second).toEqual(template)
  })

  it('fully replaces an arbitrary current layout without packing', () => {
    const arbitraryCurrent: DashboardLayoutSettings = {
      version: 1,
      columns: DASHBOARD_COLUMNS,
      tiles: EXPECTED_TILES.compact
        .toReversed()
        .map((tile) => ({ ...tile, enabled: false, x: 0, y: 0 })),
    }

    expect(applyDashboardPreset).toHaveLength(1)
    const replacement = applyDashboardPreset('taskFocus')

    expect(replacement).not.toEqual(arbitraryCurrent)
    expect(replacement).toEqual(getDashboardLayoutPreset('taskFocus').layout)
    expect(packDashboardLayoutMock).not.toHaveBeenCalled()
  })

  it.each(PRESET_IDS)('matches the exact %s preset', (id) => {
    expect(matchDashboardPreset(applyDashboardPreset(id))).toBe(id)
  })

  it.each(TILE_FIELD_MUTATIONS)(
    'returns null when tile $name differs',
    ({ mutate }) => {
      const changed = applyDashboardPreset('balanced')
      mutate(changed.tiles[0])

      expect(matchDashboardPreset(changed)).toBeNull()
    }
  )

  it('returns null when array order differs', () => {
    const changedOrder = applyDashboardPreset('balanced')
    ;[changedOrder.tiles[0], changedOrder.tiles[1]] = [
      changedOrder.tiles[1],
      changedOrder.tiles[0],
    ]

    expect(matchDashboardPreset(changedOrder)).toBeNull()
  })

  it('throws for an impossible built-in preset id', () => {
    expect(() =>
      getDashboardLayoutPreset('missing' as DashboardLayoutPresetId)
    ).toThrow('Unknown dashboard layout preset: missing')
  })
})
