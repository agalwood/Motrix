import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import {
  type TaskHistoryEvent,
  TaskHistoryEventKind,
} from '@shared/types/task-inspector-activity'

const LABELED_NODE_WIDTH = 96
const MAX_TOP_LEVEL_NODES = 7
const MAX_MARKERS = 8

export type ActivityTimelinePresentation =
  | 'event'
  | 'repeated'
  | 'cluster'
  | 'current'
  | 'truncated'

export type ActivityTimelineTone =
  | 'normal'
  | 'paused'
  | 'failed'
  | 'current'
  | 'muted'

export interface ActivityTimelineNode {
  id: string
  presentation: ActivityTimelinePresentation
  kind: TaskHistoryEventKind | null
  status: TaskStatus
  events: readonly TaskHistoryEvent[]
  count: number
  occurredAt: number
  rangeStartAt: number
  rangeEndAt: number
  tone: ActivityTimelineTone
  isCurrent: boolean
  interactive: boolean
}

export interface ActivityTimelineMarkerGroup {
  id: string
  events: readonly TaskHistoryEvent[]
  kind: TaskHistoryEventKind | null
  occurredAt: number
  rangeStartAt: number
  rangeEndAt: number
  count: number
}

export interface ActivityTimelineConnector {
  fromId: string
  toId: string
}

export interface ActivityTimelineModel {
  nodes: readonly ActivityTimelineNode[]
  connectors: readonly ActivityTimelineConnector[]
  markerGroups: readonly ActivityTimelineMarkerGroup[]
  overflow: {
    hasOverflow: boolean
    aggregatedEventCount: number
  }
}

export interface ActivityTimelineInput {
  events: readonly TaskHistoryEvent[]
  task: DownloadTask
  availableWidth: number
  selectedPauseInterval?: {
    startAt: number
    endAt: number
  } | null
  historyDroppedCount?: number
  historyTruncatedAt?: number | null
}

function toneFor(
  kind: TaskHistoryEventKind | null,
  isCurrent: boolean
): ActivityTimelineTone {
  if (kind === TaskHistoryEventKind.Failed) return 'failed'
  if (kind === TaskHistoryEventKind.Paused) return 'paused'
  if (isCurrent) return 'current'
  return 'normal'
}

function nodeForEvent(
  item: TaskHistoryEvent,
  isCurrent = false
): ActivityTimelineNode {
  return {
    id: `event-${item.eventOrdinal}`,
    presentation: isCurrent ? 'current' : 'event',
    kind: item.kind,
    status: item.toStatus,
    events: [item],
    count: 1,
    occurredAt: item.occurredAt,
    rangeStartAt: item.occurredAt,
    rangeEndAt: item.occurredAt,
    tone: toneFor(item.kind, isCurrent),
    isCurrent,
    interactive:
      item.kind === TaskHistoryEventKind.Failed ||
      item.kind === TaskHistoryEventKind.ObservedState ||
      item.kind === TaskHistoryEventKind.Paused ||
      item.kind === TaskHistoryEventKind.Resumed,
  }
}

function kindForCurrent(status: TaskStatus): TaskHistoryEventKind | null {
  if (status === TaskStatus.Completed) return TaskHistoryEventKind.Completed
  if (status === TaskStatus.Error) return TaskHistoryEventKind.Failed
  if (status === TaskStatus.Paused) return TaskHistoryEventKind.Paused
  return null
}

function currentNode(task: DownloadTask): ActivityTimelineNode {
  const kind = kindForCurrent(task.status)
  const occurredAt = task.finishedAt ?? task.updatedAt
  return {
    id: `current-${task.id}`,
    presentation: 'current',
    kind,
    status: task.status,
    events: [],
    count: 1,
    occurredAt,
    rangeStartAt: occurredAt,
    rangeEndAt: occurredAt,
    tone: toneFor(kind, true),
    isCurrent: true,
    interactive: false,
  }
}

function groupedNode(
  events: readonly TaskHistoryEvent[],
  presentation: 'repeated' | 'cluster'
): ActivityTimelineNode {
  const first = events[0]
  const last = events.at(-1)
  if (!first || !last) {
    throw new Error('timeline groups require at least one event')
  }
  const sameKind = events.every((item) => item.kind === first.kind)
  const sameDestination = events.every(
    (item) => item.toStatus === first.toStatus
  )
  return {
    id: `${presentation}-${first.eventOrdinal}-${last.eventOrdinal}`,
    presentation,
    kind: sameKind && sameDestination ? first.kind : null,
    status: last.toStatus,
    events,
    count: events.length,
    occurredAt: last.occurredAt,
    rangeStartAt: first.occurredAt,
    rangeEndAt: last.occurredAt,
    tone: sameKind ? toneFor(first.kind, false) : 'muted',
    isCurrent: false,
    interactive: true,
  }
}

function isTerminalEvent(item: TaskHistoryEvent): boolean {
  return (
    item.kind === TaskHistoryEventKind.Completed ||
    item.kind === TaskHistoryEventKind.Failed
  )
}

function isRepeatableKind(kind: TaskHistoryEventKind): boolean {
  return (
    kind === TaskHistoryEventKind.Paused ||
    kind === TaskHistoryEventKind.Resumed ||
    kind === TaskHistoryEventKind.StageChanged ||
    kind === TaskHistoryEventKind.ObservedState
  )
}

function combineRepeated(
  events: readonly TaskHistoryEvent[]
): ActivityTimelineNode[] {
  const repeatCounts = new Map<string, number>()
  const repeatKey = (item: TaskHistoryEvent) => `${item.kind}:${item.toStatus}`

  for (const item of events) {
    if (!isRepeatableKind(item.kind)) continue
    const key = repeatKey(item)
    repeatCounts.set(key, (repeatCounts.get(key) ?? 0) + 1)
  }

  const emittedGroups = new Set<string>()
  const nodes: ActivityTimelineNode[] = []
  for (const item of events) {
    const key = repeatKey(item)
    if ((repeatCounts.get(key) ?? 0) <= 1) {
      nodes.push(nodeForEvent(item))
      continue
    }
    if (emittedGroups.has(key)) continue
    emittedGroups.add(key)
    nodes.push(
      groupedNode(
        events.filter(
          (candidate) =>
            candidate.kind === item.kind && candidate.toStatus === item.toStatus
        ),
        'repeated'
      )
    )
  }
  return nodes.sort(
    (left, right) =>
      left.occurredAt - right.occurredAt ||
      (left.events[0]?.eventOrdinal ?? 0) - (right.events[0]?.eventOrdinal ?? 0)
  )
}

function chunk<T>(items: readonly T[], count: number): T[][] {
  if (items.length === 0 || count <= 0) return []
  const result: T[][] = []
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor((index * items.length) / count)
    const end = Math.floor(((index + 1) * items.length) / count)
    if (end > start) result.push(items.slice(start, end))
  }
  return result
}

function denseNodes(
  events: readonly TaskHistoryEvent[],
  capacity: number,
  selectedPauseInterval: ActivityTimelineInput['selectedPauseInterval']
): ActivityTimelineNode[] {
  const protectedEvents = new Set<TaskHistoryEvent>()
  const firstAdded = events.find(
    (item) => item.kind === TaskHistoryEventKind.Added
  )
  const firstStarted = events.find(
    (item) => item.kind === TaskHistoryEventKind.Started
  )
  const latestTerminal = [...events].reverse().find(isTerminalEvent)

  if (firstAdded) protectedEvents.add(firstAdded)
  if (firstStarted) protectedEvents.add(firstStarted)
  if (latestTerminal) protectedEvents.add(latestTerminal)

  if (selectedPauseInterval) {
    for (const item of events) {
      if (
        item.occurredAt === selectedPauseInterval.startAt ||
        item.occurredAt === selectedPauseInterval.endAt
      ) {
        protectedEvents.add(item)
      }
    }
  }

  const protectedNodes = [...protectedEvents]
    .sort((left, right) => left.eventOrdinal - right.eventOrdinal)
    .map((item) => nodeForEvent(item))
  const availableClusterSlots = Math.max(1, capacity - protectedNodes.length)
  const remaining = events.filter((item) => !protectedEvents.has(item))
  const clusters = chunk(
    remaining,
    Math.min(availableClusterSlots, remaining.length)
  ).map((items) =>
    items.length === 1
      ? nodeForEvent(items[0] as TaskHistoryEvent)
      : groupedNode(items, 'cluster')
  )

  return [...protectedNodes, ...clusters].sort(
    (left, right) =>
      left.occurredAt - right.occurredAt ||
      (left.events[0]?.eventOrdinal ?? 0) - (right.events[0]?.eventOrdinal ?? 0)
  )
}

function markerGroups(
  events: readonly TaskHistoryEvent[]
): ActivityTimelineMarkerGroup[] {
  const markers = events.filter(
    (item) =>
      item.kind === TaskHistoryEventKind.Paused ||
      item.kind === TaskHistoryEventKind.Resumed
  )
  const groups = chunk(markers, Math.min(MAX_MARKERS, markers.length))
  return groups.map((items) => {
    const first = items[0] as TaskHistoryEvent
    const last = items.at(-1) as TaskHistoryEvent
    const sameKind = items.every((item) => item.kind === first.kind)
    return {
      id: `marker-${first.eventOrdinal}-${last.eventOrdinal}`,
      events: items,
      kind: sameKind ? first.kind : null,
      occurredAt: last.occurredAt,
      rangeStartAt: first.occurredAt,
      rangeEndAt: last.occurredAt,
      count: items.length,
    }
  })
}

export function buildActivityTimelineModel(
  input: ActivityTimelineInput
): ActivityTimelineModel {
  const ordered = [...input.events].sort(
    (left, right) => left.eventOrdinal - right.eventOrdinal
  )
  const current = currentNode(input.task)
  const matchingTerminal =
    input.task.status === TaskStatus.Completed ||
    input.task.status === TaskStatus.Error
      ? [...ordered]
          .reverse()
          .find(
            (item) =>
              isTerminalEvent(item) && item.toStatus === input.task.status
          )
      : undefined
  const durable = matchingTerminal
    ? ordered.filter((item) => item !== matchingTerminal)
    : ordered
  const endpoint = matchingTerminal
    ? nodeForEvent(matchingTerminal, true)
    : current

  const capacity = Math.max(
    3,
    Math.min(
      MAX_TOP_LEVEL_NODES,
      Math.floor(Math.max(0, input.availableWidth) / LABELED_NODE_WIDTH)
    )
  )
  const historyDroppedCount = input.historyDroppedCount ?? 0
  const truncation =
    historyDroppedCount > 0 && input.historyTruncatedAt != null
      ? {
          count: historyDroppedCount,
          occurredAt: input.historyTruncatedAt,
        }
      : null
  const durableNodeCapacity = Math.max(1, capacity - 1 - (truncation ? 1 : 0))

  let nodes: ActivityTimelineNode[]
  if (ordered.length <= 5) {
    nodes = durable.map((item) => nodeForEvent(item))
  } else if (ordered.length <= 12) {
    const repeated = combineRepeated(durable)
    nodes =
      repeated.length <= durableNodeCapacity
        ? repeated
        : denseNodes(durable, durableNodeCapacity, input.selectedPauseInterval)
  } else {
    nodes = denseNodes(
      durable,
      durableNodeCapacity,
      input.selectedPauseInterval
    )
  }

  nodes.push(endpoint)

  if (truncation) {
    nodes.unshift({
      id: `truncated-${truncation.occurredAt}`,
      presentation: 'truncated',
      kind: null,
      status: ordered[0]?.toStatus ?? input.task.status,
      events: [],
      count: truncation.count,
      occurredAt: truncation.occurredAt,
      rangeStartAt: truncation.occurredAt,
      rangeEndAt: truncation.occurredAt,
      tone: 'muted',
      isCurrent: false,
      interactive: true,
    })
  }

  const representedEventCount = nodes.reduce(
    (total, node) => total + node.events.length,
    0
  )

  return {
    nodes,
    connectors: nodes.slice(1).map((node, index) => ({
      fromId: nodes[index]?.id ?? '',
      toId: node.id,
    })),
    markerGroups: markerGroups(ordered),
    overflow: {
      hasOverflow: nodes.length * LABELED_NODE_WIDTH > input.availableWidth,
      aggregatedEventCount: Math.max(0, ordered.length - representedEventCount),
    },
  }
}
