import { DEFAULT_DASHBOARD_LAYOUT } from '@shared/schemas/dashboard-layout'
import type {
  DashboardTileHeight,
  DashboardTileId,
  DashboardTileSpan,
  DashboardTileWidth,
} from '@shared/types/settings'

export type DashboardTileContentLevel =
  | 'compact'
  | 'summary'
  | 'detailed'
  | 'focus'

export type DashboardTileOrientation = 'square' | 'wide' | 'tall'

export type DashboardTileSizeLabel =
  | 'compact'
  | 'wide'
  | 'tall'
  | 'large'
  | 'fullWidth'
  | 'fullHeight'

export type DashboardTileSpanKey =
  `${DashboardTileWidth}x${DashboardTileHeight}`

export interface DashboardTilePresentationDefinition {
  span: DashboardTileSpan
  contentLevel: DashboardTileContentLevel
}

export interface DashboardTileDefinition {
  id: DashboardTileId
  titleKey: string
  defaultSpan: DashboardTileSpan
  presentations: readonly DashboardTilePresentationDefinition[]
}

export interface DashboardTileViewport {
  span: DashboardTileSpan
  orientation: DashboardTileOrientation
  contentLevel: DashboardTileContentLevel
}

const DEFAULT_SPAN_BY_ID = new Map<DashboardTileId, DashboardTileSpan>(
  DEFAULT_DASHBOARD_LAYOUT.tiles.map((tile) => [
    tile.id,
    { w: tile.w, h: tile.h },
  ])
)

function defaultSpanFor(id: DashboardTileId): DashboardTileSpan {
  const span = DEFAULT_SPAN_BY_ID.get(id)
  if (!span) {
    throw new Error(`Missing default dashboard tile span: ${id}`)
  }
  return { ...span }
}

export function dashboardTileSpanKey(
  span: DashboardTileSpan
): DashboardTileSpanKey {
  return `${span.w}x${span.h}`
}

export function dashboardTileOrientation(
  span: DashboardTileSpan
): DashboardTileOrientation {
  if (span.w === span.h) return 'square'
  return span.w > span.h ? 'wide' : 'tall'
}

export function dashboardTileSizeLabel(
  presentation: DashboardTilePresentationDefinition
): DashboardTileSizeLabel {
  if (presentation.contentLevel === 'compact') return 'compact'
  if (presentation.contentLevel === 'focus') {
    if (presentation.span.w === 4) return 'fullWidth'
    if (presentation.span.h === 3) return 'fullHeight'
    return 'large'
  }

  switch (dashboardTileOrientation(presentation.span)) {
    case 'wide':
      return 'wide'
    case 'tall':
      return 'tall'
    case 'square':
      return 'large'
  }
}

export const DASHBOARD_TILE_DEFINITIONS = [
  {
    id: 'engine',
    titleKey: 'panel.dashboard.engine.title',
    defaultSpan: defaultSpanFor('engine'),
    presentations: [
      { span: { w: 1, h: 1 }, contentLevel: 'compact' },
      { span: { w: 2, h: 1 }, contentLevel: 'summary' },
      { span: { w: 1, h: 2 }, contentLevel: 'detailed' },
      { span: { w: 2, h: 2 }, contentLevel: 'detailed' },
    ],
  },
  {
    id: 'speedLimit',
    titleKey: 'panel.dashboard.speedLimit.title',
    defaultSpan: defaultSpanFor('speedLimit'),
    presentations: [
      { span: { w: 1, h: 1 }, contentLevel: 'compact' },
      { span: { w: 2, h: 1 }, contentLevel: 'summary' },
      { span: { w: 1, h: 2 }, contentLevel: 'detailed' },
      { span: { w: 2, h: 2 }, contentLevel: 'detailed' },
    ],
  },
  {
    id: 'speedUp',
    titleKey: 'panel.dashboard.speedUp.title',
    defaultSpan: defaultSpanFor('speedUp'),
    presentations: [
      { span: { w: 1, h: 1 }, contentLevel: 'compact' },
      { span: { w: 2, h: 1 }, contentLevel: 'summary' },
      { span: { w: 3, h: 1 }, contentLevel: 'detailed' },
      { span: { w: 4, h: 1 }, contentLevel: 'focus' },
      { span: { w: 2, h: 2 }, contentLevel: 'detailed' },
      { span: { w: 3, h: 2 }, contentLevel: 'focus' },
    ],
  },
  {
    id: 'speedDown',
    titleKey: 'panel.dashboard.speedDown.title',
    defaultSpan: defaultSpanFor('speedDown'),
    presentations: [
      { span: { w: 1, h: 1 }, contentLevel: 'compact' },
      { span: { w: 2, h: 1 }, contentLevel: 'summary' },
      { span: { w: 3, h: 1 }, contentLevel: 'detailed' },
      { span: { w: 4, h: 1 }, contentLevel: 'focus' },
      { span: { w: 2, h: 2 }, contentLevel: 'detailed' },
      { span: { w: 3, h: 2 }, contentLevel: 'focus' },
    ],
  },
  {
    id: 'active',
    titleKey: 'panel.dashboard.active.title',
    defaultSpan: defaultSpanFor('active'),
    presentations: [
      { span: { w: 1, h: 1 }, contentLevel: 'compact' },
      { span: { w: 2, h: 1 }, contentLevel: 'summary' },
      { span: { w: 2, h: 2 }, contentLevel: 'detailed' },
      { span: { w: 4, h: 1 }, contentLevel: 'focus' },
    ],
  },
  {
    id: 'transfer',
    titleKey: 'panel.dashboard.transfer.title',
    defaultSpan: defaultSpanFor('transfer'),
    presentations: [
      { span: { w: 1, h: 1 }, contentLevel: 'compact' },
      { span: { w: 2, h: 1 }, contentLevel: 'summary' },
      { span: { w: 1, h: 2 }, contentLevel: 'detailed' },
      { span: { w: 2, h: 2 }, contentLevel: 'detailed' },
      { span: { w: 4, h: 1 }, contentLevel: 'focus' },
    ],
  },
  {
    id: 'activity',
    titleKey: 'panel.dashboard.activity.title',
    defaultSpan: defaultSpanFor('activity'),
    presentations: [
      { span: { w: 1, h: 1 }, contentLevel: 'compact' },
      { span: { w: 2, h: 1 }, contentLevel: 'summary' },
      { span: { w: 3, h: 1 }, contentLevel: 'detailed' },
      { span: { w: 4, h: 1 }, contentLevel: 'focus' },
      { span: { w: 2, h: 2 }, contentLevel: 'detailed' },
      { span: { w: 3, h: 2 }, contentLevel: 'focus' },
      { span: { w: 4, h: 2 }, contentLevel: 'focus' },
    ],
  },
  {
    id: 'tasks',
    titleKey: 'panel.dashboard.tasks.title',
    defaultSpan: defaultSpanFor('tasks'),
    presentations: [
      { span: { w: 2, h: 1 }, contentLevel: 'summary' },
      { span: { w: 2, h: 2 }, contentLevel: 'detailed' },
      { span: { w: 2, h: 3 }, contentLevel: 'focus' },
      { span: { w: 3, h: 2 }, contentLevel: 'focus' },
      { span: { w: 3, h: 3 }, contentLevel: 'focus' },
      { span: { w: 4, h: 2 }, contentLevel: 'focus' },
    ],
  },
  {
    id: 'nat',
    titleKey: 'panel.dashboard.nat.title',
    defaultSpan: defaultSpanFor('nat'),
    presentations: [
      { span: { w: 1, h: 1 }, contentLevel: 'compact' },
      { span: { w: 2, h: 1 }, contentLevel: 'summary' },
      { span: { w: 1, h: 2 }, contentLevel: 'detailed' },
      { span: { w: 2, h: 2 }, contentLevel: 'detailed' },
      { span: { w: 2, h: 3 }, contentLevel: 'focus' },
    ],
  },
] as const satisfies readonly DashboardTileDefinition[]

export const DASHBOARD_TILE_DEFINITION_BY_ID = new Map<
  DashboardTileId,
  DashboardTileDefinition
>(DASHBOARD_TILE_DEFINITIONS.map((definition) => [definition.id, definition]))

export function getDashboardTileDefinition(
  id: DashboardTileId
): DashboardTileDefinition {
  const definition = DASHBOARD_TILE_DEFINITION_BY_ID.get(id)
  if (!definition) {
    throw new Error(`Unknown dashboard tile: ${id}`)
  }
  return definition
}

export function getDashboardTilePresentations(
  id: DashboardTileId
): readonly DashboardTilePresentationDefinition[] {
  return getDashboardTileDefinition(id).presentations
}

export function getDashboardTilePresentation(
  id: DashboardTileId,
  span: DashboardTileSpan
): DashboardTilePresentationDefinition | undefined {
  const key = dashboardTileSpanKey(span)
  return getDashboardTilePresentations(id).find(
    (presentation) => dashboardTileSpanKey(presentation.span) === key
  )
}

function spanDistance(
  candidate: DashboardTileSpan,
  target: DashboardTileSpan
): number {
  return Math.abs(candidate.w - target.w) + Math.abs(candidate.h - target.h)
}

function spanAreaDifference(
  candidate: DashboardTileSpan,
  target: DashboardTileSpan
): number {
  return Math.abs(candidate.w * candidate.h - target.w * target.h)
}

export function nearestDashboardTilePresentation(
  id: DashboardTileId,
  span: DashboardTileSpan
): DashboardTilePresentationDefinition {
  const exact = getDashboardTilePresentation(id, span)
  if (exact) return exact

  const presentations = getDashboardTilePresentations(id)
  const nearest = presentations.reduce<
    DashboardTilePresentationDefinition | undefined
  >((best, candidate) => {
    if (!best) return candidate

    const candidateDistance = spanDistance(candidate.span, span)
    const bestDistance = spanDistance(best.span, span)
    if (candidateDistance !== bestDistance) {
      return candidateDistance < bestDistance ? candidate : best
    }

    const candidateAreaDifference = spanAreaDifference(candidate.span, span)
    const bestAreaDifference = spanAreaDifference(best.span, span)
    return candidateAreaDifference < bestAreaDifference ? candidate : best
  }, undefined)

  if (!nearest) {
    throw new Error(`Dashboard tile has no presentations: ${id}`)
  }
  return nearest
}

export function normalizeDashboardTilePresentation(
  id: DashboardTileId,
  span: DashboardTileSpan
): DashboardTilePresentationDefinition {
  const exact = getDashboardTilePresentation(id, span)
  if (exact) return exact

  const targetOrientation = dashboardTileOrientation(span)
  const presentations = getDashboardTilePresentations(id)
  const nearest = presentations.reduce<
    DashboardTilePresentationDefinition | undefined
  >((best, candidate) => {
    if (!best) return candidate

    const candidateOrientationPenalty =
      dashboardTileOrientation(candidate.span) === targetOrientation ? 0 : 1
    const bestOrientationPenalty =
      dashboardTileOrientation(best.span) === targetOrientation ? 0 : 1
    if (candidateOrientationPenalty !== bestOrientationPenalty) {
      return candidateOrientationPenalty < bestOrientationPenalty
        ? candidate
        : best
    }

    const candidateDistance = spanDistance(candidate.span, span)
    const bestDistance = spanDistance(best.span, span)
    if (candidateDistance !== bestDistance) {
      return candidateDistance < bestDistance ? candidate : best
    }

    const candidateAreaDifference = spanAreaDifference(candidate.span, span)
    const bestAreaDifference = spanAreaDifference(best.span, span)
    return candidateAreaDifference < bestAreaDifference ? candidate : best
  }, undefined)

  if (!nearest) {
    throw new Error(`Dashboard tile has no presentations: ${id}`)
  }
  return nearest
}

export function dashboardTileViewport(
  id: DashboardTileId,
  span: DashboardTileSpan
): DashboardTileViewport {
  const presentation = normalizeDashboardTilePresentation(id, span)
  return {
    span: { ...presentation.span },
    orientation: dashboardTileOrientation(presentation.span),
    contentLevel: presentation.contentLevel,
  }
}
