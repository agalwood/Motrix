import type {
  DashboardLayoutSettings,
  DashboardTileLayout,
} from '@shared/types/settings'

export type DashboardLayoutPresetId =
  | 'balanced'
  | 'taskFocus'
  | 'speedFocus'
  | 'compact'

export interface DashboardLayoutPreset {
  id: DashboardLayoutPresetId
  titleKey: string
  descriptionKey: string
  layout: DashboardLayoutSettings
}

export const DASHBOARD_LAYOUT_PRESETS: readonly DashboardLayoutPreset[] = [
  {
    id: 'balanced',
    titleKey: 'panel.dashboard.configure.presets.balanced.title',
    descriptionKey: 'panel.dashboard.configure.presets.balanced.description',
    layout: {
      version: 1,
      columns: 4,
      tiles: [
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
    },
  },
  {
    id: 'taskFocus',
    titleKey: 'panel.dashboard.configure.presets.taskFocus.title',
    descriptionKey: 'panel.dashboard.configure.presets.taskFocus.description',
    layout: {
      version: 1,
      columns: 4,
      tiles: [
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
    },
  },
  {
    id: 'speedFocus',
    titleKey: 'panel.dashboard.configure.presets.speedFocus.title',
    descriptionKey: 'panel.dashboard.configure.presets.speedFocus.description',
    layout: {
      version: 1,
      columns: 4,
      tiles: [
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
    },
  },
  {
    id: 'compact',
    titleKey: 'panel.dashboard.configure.presets.compact.title',
    descriptionKey: 'panel.dashboard.configure.presets.compact.description',
    layout: {
      version: 1,
      columns: 4,
      tiles: [
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
    },
  },
]

export const DASHBOARD_LAYOUT_PRESET_BY_ID = new Map<
  DashboardLayoutPresetId,
  DashboardLayoutPreset
>(DASHBOARD_LAYOUT_PRESETS.map((preset) => [preset.id, preset]))

function cloneDashboardLayout(
  layout: DashboardLayoutSettings
): DashboardLayoutSettings {
  return {
    ...layout,
    tiles: layout.tiles.map((tile) => ({ ...tile })),
  }
}

function sameTileLayout(
  left: DashboardTileLayout,
  right: DashboardTileLayout
): boolean {
  return (
    left.id === right.id &&
    left.enabled === right.enabled &&
    left.x === right.x &&
    left.y === right.y &&
    left.w === right.w &&
    left.h === right.h
  )
}

function sameDashboardLayout(
  left: DashboardLayoutSettings,
  right: DashboardLayoutSettings
): boolean {
  return (
    left.version === right.version &&
    left.columns === right.columns &&
    left.tiles.length === right.tiles.length &&
    left.tiles.every((tile, index) => {
      const other = right.tiles[index]
      return other ? sameTileLayout(tile, other) : false
    })
  )
}

export function getDashboardLayoutPreset(
  id: DashboardLayoutPresetId
): DashboardLayoutPreset {
  const preset = DASHBOARD_LAYOUT_PRESET_BY_ID.get(id)
  if (!preset) {
    throw new Error(`Unknown dashboard layout preset: ${id}`)
  }
  return preset
}

export function applyDashboardPreset(
  id: DashboardLayoutPresetId
): DashboardLayoutSettings {
  return cloneDashboardLayout(getDashboardLayoutPreset(id).layout)
}

export function matchDashboardPreset(
  layout: DashboardLayoutSettings
): DashboardLayoutPresetId | null {
  for (const preset of DASHBOARD_LAYOUT_PRESETS) {
    if (sameDashboardLayout(layout, preset.layout)) return preset.id
  }
  return null
}
