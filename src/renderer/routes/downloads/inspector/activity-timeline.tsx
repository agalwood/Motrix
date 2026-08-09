import { Button } from '@renderer/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@renderer/components/ui/popover'
import { resolveFailureReason } from '@renderer/lib/failure-reason'
import { formatTime24Hour } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import type { TaskErrorFields } from '@shared/task-error/descriptor'
import {
  type TaskHistoryEvent,
  TaskHistoryEventKind,
} from '@shared/types/task-inspector-activity'
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  Ellipsis,
  History,
  Pause,
  Play,
  RefreshCw,
} from 'lucide-react'
import { type CSSProperties, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  ActivityTimelineModel,
  ActivityTimelineNode,
} from './activity-timeline-model'

export interface ActivityTimelineProps {
  model: ActivityTimelineModel
  selectedNodeId: string | null
  onSelectNode: (node: ActivityTimelineNode) => void
}

function nodeIcon(node: ActivityTimelineNode) {
  if (node.presentation === 'truncated') return History
  if (node.presentation === 'cluster' || node.presentation === 'repeated') {
    return Ellipsis
  }
  switch (node.kind) {
    case TaskHistoryEventKind.Added:
    case TaskHistoryEventKind.Completed:
      return Check
    case TaskHistoryEventKind.Started:
    case TaskHistoryEventKind.Resumed:
      return Play
    case TaskHistoryEventKind.Paused:
      return Pause
    case TaskHistoryEventKind.Failed:
      return AlertTriangle
    case TaskHistoryEventKind.StageChanged:
    case TaskHistoryEventKind.ObservedState:
      return RefreshCw
    default:
      return Circle
  }
}

function formatTimelineTime(timestamp: number, locale: string): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  return formatTime24Hour(timestamp, locale)
}

function localizedEventLabel(
  kind: TaskHistoryEventKind,
  status: ActivityTimelineNode['status'],
  t: ReturnType<typeof useTranslation>['t']
): string {
  const event = t(
    `panel.downloads.inspector.activity.timeline.event.${kind}` as const
  )
  if (
    kind !== TaskHistoryEventKind.StageChanged &&
    kind !== TaskHistoryEventKind.ObservedState
  ) {
    return event
  }
  return t('panel.downloads.inspector.activity.timeline.destination', {
    event,
    status: t(
      `panel.downloads.inspector.activity.timeline.status.${status}` as const
    ),
  })
}

function nodeLabel(
  node: ActivityTimelineNode,
  t: ReturnType<typeof useTranslation>['t']
): string {
  if (node.presentation === 'truncated') {
    return t('panel.downloads.inspector.activity.timeline.truncated', {
      count: node.count,
    })
  }
  if (node.presentation === 'cluster') {
    return t('panel.downloads.inspector.activity.timeline.cluster', {
      count: node.count,
    })
  }

  const eventLabel = node.kind
    ? localizedEventLabel(node.kind, node.status, t)
    : t(
        `panel.downloads.inspector.activity.timeline.status.${node.status}` as const
      )
  if (node.presentation === 'repeated') {
    return t('panel.downloads.inspector.activity.timeline.repeated', {
      label: eventLabel,
      count: node.count,
    })
  }
  if (node.isCurrent && node.kind === null) {
    return t('panel.downloads.inspector.activity.timeline.current', {
      status: eventLabel,
    })
  }
  return eventLabel
}

function HistoryEventError({ item }: { item: TaskHistoryEvent }) {
  const { t, i18n } = useTranslation()
  if (!item.errorCode && !item.errorDetailKey && !item.errorMessage) return null

  const failure = resolveFailureReason(
    {
      errorCode: item.errorCode as TaskErrorFields['errorCode'],
      errorMessage: item.errorMessage,
      errorDetailKey: item.errorDetailKey,
      errorDetailParams: item.errorDetailParams,
    },
    { t, exists: (key) => i18n.exists(key) }
  )
  const technicalDetail = [item.errorCode, item.errorMessage]
    .filter(Boolean)
    .join(' — ')

  return (
    <>
      <p
        data-testid="activity-timeline-error-reason"
        className="mt-1 text-xs text-destructive"
      >
        {failure.reason}
      </p>
      {technicalDetail && (
        <p
          data-testid="activity-timeline-error-detail"
          className="mt-0.5 text-xs text-muted-foreground"
        >
          {technicalDetail}
        </p>
      )}
    </>
  )
}

function NodeDetails({
  node,
  locale,
}: {
  node: ActivityTimelineNode
  locale: string
}) {
  const { t } = useTranslation()
  return (
    <div className="max-h-60 overflow-y-auto">
      {node.presentation === 'truncated' && (
        <div className="space-y-1 text-xs">
          <p className="font-medium text-foreground">
            {t('panel.downloads.inspector.activity.timeline.truncated', {
              count: node.count,
            })}
          </p>
          <p className="text-muted-foreground tabular-nums">
            {t('panel.downloads.inspector.activity.timeline.truncatedAt', {
              time: formatTimelineTime(node.occurredAt, locale),
            })}
          </p>
        </div>
      )}
      <ol className="space-y-2">
        {node.events.map((item) => (
          <li
            key={item.eventKey}
            className="border-b border-border/60 pb-2 last:border-0 last:pb-0"
          >
            <div className="flex items-baseline justify-between gap-3 text-xs">
              <span className="font-medium text-foreground">
                {localizedEventLabel(item.kind, item.toStatus, t)}
              </span>
              <time className="shrink-0 text-muted-foreground tabular-nums">
                {formatTimelineTime(item.occurredAt, locale)}
              </time>
            </div>
            <HistoryEventError item={item} />
          </li>
        ))}
      </ol>
    </div>
  )
}

function TimelineNodeView({
  node,
  selected,
  onSelect,
}: {
  node: ActivityTimelineNode
  selected: boolean
  onSelect: () => void
}) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const Icon = nodeIcon(node)
  const label = nodeLabel(node, t)
  const time =
    node.rangeStartAt === node.rangeEndAt
      ? formatTimelineTime(node.occurredAt, i18n.language)
      : t('panel.downloads.inspector.activity.timeline.timeRange', {
          start: formatTimelineTime(node.rangeStartAt, i18n.language),
          end: formatTimelineTime(node.rangeEndAt, i18n.language),
        })
  const toneClass =
    node.tone === 'failed'
      ? 'border-destructive bg-destructive text-destructive-foreground'
      : node.tone === 'paused'
        ? 'border-amber-500 bg-amber-500 text-white'
        : node.tone === 'current'
          ? 'border-primary bg-background text-primary ring-2 ring-primary/20'
          : node.tone === 'muted'
            ? 'border-muted-foreground/40 bg-muted text-muted-foreground'
            : 'border-primary bg-primary text-primary-foreground'

  const content = (
    <>
      <span
        aria-hidden="true"
        className={cn(
          'relative z-10 flex size-5 items-center justify-center rounded-full border',
          'motion-reduce:transition-none',
          toneClass,
          selected && 'ring-2 ring-ring ring-offset-2 ring-offset-background'
        )}
      >
        <Icon className="size-3" />
      </span>
      <span className="mt-1.5 max-w-full px-1 text-[11px] font-medium leading-tight text-foreground [overflow-wrap:anywhere]">
        {label}
      </span>
      <span className="text-[10px] text-muted-foreground tabular-nums">
        {time}
      </span>
    </>
  )

  if (!node.interactive) {
    return (
      <div
        role="img"
        data-testid={`activity-timeline-node-${node.id}`}
        className="flex min-w-0 flex-col items-center text-center"
        aria-label={`${label} ${time}`}
      >
        {content}
      </div>
    )
  }

  return (
    <Popover
      modal
      open={open}
      onOpenChange={(nextOpen, eventDetails) => {
        if (!nextOpen && eventDetails.reason === 'escape-key') {
          eventDetails.event.stopPropagation()
        }
        setOpen(nextOpen)
      }}
    >
      <PopoverTrigger
        render={
          <button
            ref={triggerRef}
            type="button"
            data-testid={`activity-timeline-node-${node.id}`}
            className="flex min-w-0 flex-col items-center rounded-md text-center outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            aria-label={`${label} ${time}`}
            onClick={onSelect}
          />
        }
      >
        {content}
      </PopoverTrigger>
      <PopoverContent
        role="dialog"
        data-activity-detail-surface="true"
        aria-label={t(
          'panel.downloads.inspector.activity.timeline.detailTitle',
          { label }
        )}
        align="center"
        className="w-72 border-border bg-popover opacity-100 shadow-xl motion-reduce:animate-none"
        finalFocus={triggerRef}
      >
        <NodeDetails node={node} locale={i18n.language} />
      </PopoverContent>
    </Popover>
  )
}

export function ActivityTimeline({
  model,
  selectedNodeId,
  onSelectNode,
}: ActivityTimelineProps) {
  const { t } = useTranslation()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const minimumWidth = model.overflow.hasOverflow
    ? model.nodes.length * 96
    : undefined

  const scrollTimeline = (direction: -1 | 1) => {
    scrollerRef.current?.scrollBy({ left: direction * 240 })
  }

  return (
    <section
      data-testid="task-inspector-activity-timeline"
      className="w-full min-w-0"
      aria-labelledby="task-inspector-activity-timeline-title"
    >
      <h4
        id="task-inspector-activity-timeline-title"
        className="mb-2 text-xs font-semibold text-foreground"
      >
        {t('panel.downloads.inspector.activity.timeline.title')}
      </h4>
      <div className="relative">
        {model.overflow.hasOverflow && (
          <>
            <div
              data-testid="activity-timeline-edge-start"
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-[linear-gradient(to_right,hsl(var(--background)),transparent)]"
            />
            <div
              data-testid="activity-timeline-edge-end"
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-[linear-gradient(to_left,hsl(var(--background)),transparent)]"
            />
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              className="absolute left-0 top-0 z-20 bg-background motion-reduce:transition-none"
              aria-label={t(
                'panel.downloads.inspector.activity.timeline.previous'
              )}
              onClick={() => scrollTimeline(-1)}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              className="absolute right-0 top-0 z-20 bg-background motion-reduce:transition-none"
              aria-label={t('panel.downloads.inspector.activity.timeline.next')}
              onClick={() => scrollTimeline(1)}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </>
        )}
        <div
          ref={scrollerRef}
          data-testid="activity-timeline-scroller"
          className="overflow-x-auto overflow-y-hidden py-1"
        >
          <div
            className="relative grid min-h-16 items-start gap-1 px-1"
            style={{
              gridTemplateColumns: `repeat(${Math.max(1, model.nodes.length)}, minmax(72px, 1fr))`,
              minWidth: minimumWidth,
            }}
          >
            {model.nodes.length > 1 && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute left-[calc(50%/var(--activity-node-count))] right-[calc(50%/var(--activity-node-count))] top-2.5 border-t border-border"
                style={
                  {
                    '--activity-node-count': model.nodes.length,
                  } as CSSProperties
                }
              />
            )}
            {model.nodes.map((node) => (
              <TimelineNodeView
                key={node.id}
                node={node}
                selected={selectedNodeId === node.id}
                onSelect={() => onSelectNode(node)}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
