import { PanelShell } from '@renderer/components/desktop-kit/panel/panel-shell'
import { useNotifications } from '@renderer/components/notification-center/use-notifications'
import { Button } from '@renderer/components/ui/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { SEVERITY_ICONS } from '@renderer/components/ui/severity-icons'
import { useMinuteClock } from '@renderer/hooks/use-minute-clock'
import { resolveNotificationText } from '@renderer/lib/notification-text'
import { formatRelativeTime } from '@renderer/lib/relative-time'
import { cn } from '@renderer/lib/utils'
import type { AppNotification } from '@shared/types/notification'
import { BellOff, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'

function NotificationRow({
  item,
  now,
  onOpen,
  onDelete,
}: {
  item: AppNotification
  now: number
  onOpen: () => void
  onDelete: () => void
}) {
  const { t, i18n } = useTranslation()
  // item.severity is DB-sourced and the store cast is unchecked (see
  // resolveNotificationText's docstring in `@renderer/lib/notification-text`
  // for the sibling gap on titleKey/bodyKey) — a tampered row with an
  // out-of-set severity must fall back rather than crash the whole
  // renderer (no page ErrorBoundary wraps this list).
  const meta = SEVERITY_ICONS[item.severity] ?? SEVERITY_ICONS.info
  const Icon = meta.icon
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

  return (
    // biome-ignore lint/a11y/useSemanticElements: pairs with the role="list" container in NotificationsPage, which can't be a native <ul> because it also renders the non-list <Empty> state.
    <div
      role="listitem"
      className="group relative flex w-full border-b border-border last:border-b-0 hover:bg-accent"
    >
      <button
        type="button"
        aria-label={
          unread ? t('notification.center.rowUnreadAria', { title }) : title
        }
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-start gap-2 px-3 py-2 text-left"
      >
        <Icon className={cn('mt-0.5 size-4 shrink-0', meta.iconClassName)} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            {unread && (
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full bg-primary"
              />
            )}
            <span className="truncate text-sm font-medium text-foreground">
              {title}
            </span>
          </div>
          {body && (
            <span className="truncate text-xs text-muted-foreground">
              {body}
            </span>
          )}
          <span className="text-[11px] text-muted-foreground">
            {formatRelativeTime(item.createdAt, now, i18n.language)}
          </span>
        </div>
      </button>
      <button
        type="button"
        aria-label={t('common.remove')}
        onClick={onDelete}
        className="absolute top-2 right-2 shrink-0 rounded-md p-1 text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  )
}

/**
 * Dedicated notification center page (Task 17R rework, 2026-08-04 —
 * supersedes the Task 17 Popover design per user decision). Mirrors
 * `TrackersPage`/`PluginsPage`'s `PanelShell` skeleton: header actions are
 * mark-all-read + clear, content is a single `overflow-auto` region per
 * `panel-layout.md` (no `max-h-80` — the page fills the inset). Rows are
 * ported verbatim from the retired `NotificationPanel`. Runs its own
 * `useNotifications()` instance, independent of the sidebar's badge — the
 * page only mounts when routed, so there is no double-fetch while it's
 * off-screen. `useMinuteClock()` (shared with `TasksTile`) ticks each row's
 * relative timestamp forward once a minute instead of freezing at the value
 * read when the row first mounted.
 */
export function NotificationsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { items, markRead, markAllRead, remove, clear } = useNotifications()
  const now = useMinuteClock()
  const hasItems = items.length > 0

  return (
    <PanelShell
      title={t('notification.center.title')}
      actions={
        <div className="flex gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!hasItems}
            onClick={() => void markAllRead()}
          >
            {t('notification.center.markAllRead')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!hasItems}
            onClick={() => void clear()}
          >
            {t('notification.center.clearAll')}
          </Button>
        </div>
      }
      contentClassName="px-6 pb-6"
    >
      {/* This is the single scroll region from panel-layout.md's
          height-chain pattern; it renders the non-list <Empty> state when
          there are no notifications, so `role` only claims "list" once
          there's actually a list to announce — it can't be a native <ul>
          either way. */}
      <div
        role={hasItems ? 'list' : undefined}
        className="flex min-h-0 flex-1 flex-col overflow-auto rounded-md border border-border"
      >
        {hasItems ? (
          items.map((item) => (
            <NotificationRow
              key={item.id}
              item={item}
              now={now}
              onOpen={() => {
                void markRead(item.id)
                if (item.taskId != null) {
                  navigate(`/downloads/all?task=${item.taskId}`)
                }
              }}
              onDelete={() => void remove(item.id)}
            />
          ))
        ) : (
          <Empty className="gap-1 px-4 py-8">
            <EmptyHeader className="gap-1">
              <EmptyMedia className="mb-1 text-muted-foreground [&_svg]:size-8">
                <BellOff />
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
      </div>
    </PanelShell>
  )
}
