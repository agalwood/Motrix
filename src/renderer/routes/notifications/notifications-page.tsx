import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaViewport,
  ScrollBar,
} from '@renderer/components/ui/scroll-area'
import './notifications-list.css'
import { PanelShell } from '@renderer/components/desktop-kit/panel/panel-shell'
import { Toolbar } from '@renderer/components/desktop-kit/toolbar/toolbar'
import { ToolbarButton } from '@renderer/components/desktop-kit/toolbar/toolbar-button'
import { ToolbarGroup } from '@renderer/components/desktop-kit/toolbar/toolbar-group'
import {
  MarkAllReadIcon,
  NotificationsIcon,
  RemoveIcon,
} from '@renderer/components/icons'
import { useNotifications } from '@renderer/components/notification-center/use-notifications'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { useMinuteClock } from '@renderer/hooks/use-minute-clock'
import { getTaskListSnapshot, useTaskList } from '@renderer/hooks/use-task-list'
import { resolveNotificationText } from '@renderer/lib/notification-text'
import { formatRelativeTime } from '@renderer/lib/relative-time'
import { transport } from '@renderer/lib/transport'
import { cn } from '@renderer/lib/utils'
import { isTaskAvailable, resolveTaskRoute } from '@shared/lib/task-navigation'
import { Queries } from '@shared/protocol/queries'
import type { AppNotification } from '@shared/types/notification'
import type { DownloadTask } from '@shared/types/task'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { NotificationIcon } from './notification-icon'

function NotificationRow({
  item,
  now,
  onRead,
  onOpen,
  onDelete,
  busy,
  taskMissing,
}: {
  item: AppNotification
  now: number
  onRead: () => void
  onOpen: () => void
  onDelete: () => void
  busy: boolean
  taskMissing: boolean
}) {
  const { t, i18n } = useTranslation()
  const descriptionId = useId()
  const statusId = useId()
  const title = resolveNotificationText(
    item.titleKey,
    item.titleParams,
    t,
    i18n.exists
  )
  const body =
    item.bodyKey != null
      ? resolveNotificationText(item.bodyKey, item.bodyParams, t, i18n.exists)
      : null
  const unread = item.readAt === null
  const canOpen = item.taskId != null && !taskMissing
  const validDate =
    Number.isFinite(item.createdAt) &&
    item.createdAt > 0 &&
    item.createdAt <= 8.64e15
  const date = validDate ? new Date(item.createdAt) : null

  return (
    <li className="notification-row group relative isolate flex w-full items-start">
      <button
        type="button"
        aria-label={
          unread ? t('notification.center.rowUnreadAria', { title }) : title
        }
        aria-describedby={
          [body ? descriptionId : null, taskMissing ? statusId : null]
            .filter(Boolean)
            .join(' ') || undefined
        }
        title={
          canOpen
            ? t('notification.center.viewTask')
            : taskMissing
              ? t('notification.center.taskRemoved')
              : unread
                ? t('notification.center.markRead')
                : undefined
        }
        disabled={busy || (!canOpen && !unread)}
        onClick={canOpen ? onOpen : onRead}
        className="notification-row-button notification-row-content min-w-0 flex-1 text-start outline-none"
      >
        <span
          aria-hidden="true"
          className={cn(
            'mt-[7px] size-1.5 rounded-full',
            unread && 'bg-sky-600 dark:bg-sky-400'
          )}
        />
        <NotificationIcon item={item} />
        <span className="flex min-w-0 flex-col gap-1">
          <span
            className={cn(
              'text-[13px]/5 text-foreground [overflow-wrap:anywhere]',
              unread ? 'font-semibold' : 'font-normal'
            )}
          >
            {title}
          </span>
          {body && (
            <span
              id={descriptionId}
              className="whitespace-pre-wrap text-xs/5 text-muted-foreground [overflow-wrap:anywhere]"
            >
              {body}
            </span>
          )}
        </span>
        <span className="notification-row-meta flex flex-col items-end gap-1">
          <time
            dateTime={date?.toISOString()}
            title={date?.toLocaleString(i18n.language)}
            className="whitespace-nowrap text-[11px]/5 tabular-nums text-muted-foreground"
          >
            {formatRelativeTime(item.createdAt, now, i18n.language)}
          </time>
          {taskMissing && (
            <span
              id={statusId}
              className="whitespace-nowrap text-[11px]/5 text-muted-foreground"
            >
              {t('notification.center.taskRemoved')}
            </span>
          )}
        </span>
      </button>
      <div className="flex w-9 shrink-0 justify-center pt-2">
        <button
          type="button"
          aria-label={t('notification.center.removeAria', { title })}
          title={t('common.remove')}
          disabled={busy}
          onClick={onDelete}
          className="notification-row-remove relative z-10 flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none hover:bg-accent hover:text-destructive group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
        >
          <RemoveIcon aria-hidden="true" className="size-3.5" />
        </button>
      </div>
    </li>
  )
}

export function NotificationsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { items, unreadCount, markRead, markAllRead, remove, clear } =
    useNotifications()
  const now = useMinuteClock()
  const { tasks, status: taskListStatus } = useTaskList()
  const availableTaskIds = useMemo(
    () =>
      new Set(
        tasks
          .filter((task) => isTaskAvailable(task.status))
          .map((task) => task.id)
      ),
    [tasks]
  )
  const [missingTaskIds, setMissingTaskIds] = useState(new Set<string>())
  const hasItems = items.length > 0
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const [failureKey, setFailureKey] = useState<string | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const runAction = async (
    action: () => Promise<void>,
    errorKey = 'notification.center.actionFailed'
  ) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setFailureKey(null)
    try {
      await action()
    } catch {
      if (mounted.current) setFailureKey(errorKey)
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const openTask = (item: AppNotification) =>
    runAction(async () => {
      const taskId = item.taskId
      if (taskId == null) return
      if (item.readAt === null) await markRead(item.id)
      if (!mounted.current) return
      const revision = getTaskListSnapshot().revision
      const task = (await transport.invoke(
        Queries.GetTaskDetail,
        taskId
      )) as DownloadTask | null
      if (!mounted.current) return
      const latest = getTaskListSnapshot()
      const removedDuringCheck =
        latest.revision !== revision &&
        latest.status === 'ready' &&
        !latest.tasks.some(
          (candidate) =>
            candidate.id === taskId && isTaskAvailable(candidate.status)
        )
      if (task == null || !isTaskAvailable(task.status) || removedDuringCheck) {
        setMissingTaskIds((ids) => new Set(ids).add(taskId))
        return
      }
      navigate(resolveTaskRoute(taskId, task.status))
    }, 'notification.center.openTaskFailed')

  return (
    <PanelShell
      title={t('notification.center.title')}
      actions={
        <Toolbar
          label={t('notification.center.title')}
          data-slot="notifications-toolbar"
        >
          <ToolbarGroup>
            <ToolbarButton
              label={t('notification.center.markAllRead')}
              disabled={unreadCount === 0 || busy}
              onClick={() => void runAction(markAllRead)}
            >
              <MarkAllReadIcon aria-hidden="true" />
            </ToolbarButton>
            <ToolbarButton
              label={t('notification.center.clearAll')}
              disabled={!hasItems || busy}
              onClick={() => void runAction(clear)}
            >
              <RemoveIcon aria-hidden="true" />
            </ToolbarButton>
          </ToolbarGroup>
        </Toolbar>
      }
      contentClassName="px-6 pb-6"
    >
      {failureKey && (
        <p role="alert" className="shrink-0 pb-3 text-xs text-destructive">
          {t(failureKey)}
        </p>
      )}
      <ScrollArea
        className={cn(
          'notification-list min-h-0 flex-1 flex min-w-0 flex-col rounded-md',
          hasItems && 'border border-border'
        )}
      >
        <ScrollAreaViewport className="min-h-0 flex-1 overscroll-contain">
          <ScrollAreaContent
            className="flex min-h-full flex-col"
            style={{ minWidth: '100%' }}
          >
            {hasItems ? (
              <ul aria-label={t('notification.center.title')}>
                {items.map((item) => (
                  <NotificationRow
                    key={item.id}
                    item={item}
                    now={now}
                    busy={busy}
                    taskMissing={
                      item.taskId != null &&
                      (missingTaskIds.has(item.taskId) ||
                        (taskListStatus === 'ready' &&
                          !availableTaskIds.has(item.taskId)))
                    }
                    onRead={() => {
                      if (item.readAt === null)
                        void runAction(() => markRead(item.id))
                    }}
                    onOpen={() => void openTask(item)}
                    onDelete={() => void runAction(() => remove(item.id))}
                  />
                ))}
              </ul>
            ) : (
              <Empty className="flex-1 gap-1 px-4 py-8">
                <EmptyHeader className="gap-1">
                  <EmptyMedia className="mb-2 size-12 rounded-2xl bg-black/5 text-muted-foreground dark:bg-white/8 [&_svg]:size-6">
                    <NotificationsIcon strokeWidth={1.5} />
                  </EmptyMedia>
                  <EmptyTitle className="font-sans text-sm font-medium tracking-normal">
                    {t('notification.center.empty')}
                  </EmptyTitle>
                  <EmptyDescription className="text-xs/normal">
                    {t('notification.center.emptyDesc')}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </ScrollAreaContent>
        </ScrollAreaViewport>
        <ScrollBar />
      </ScrollArea>
    </PanelShell>
  )
}
