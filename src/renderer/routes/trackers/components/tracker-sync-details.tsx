import { InfoIcon } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaViewport,
  ScrollBar,
} from '@renderer/components/ui/scroll-area'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@renderer/components/ui/tabs'
import { useTrackerList } from '@renderer/hooks/use-tracker-list'
import { useTransportMirror } from '@renderer/hooks/use-transport-mirror'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { TRACKER_SOURCE_MAX_AGE_MS } from '@shared/schemas/tracker-state'
import type { AppSettings, TrackerSettings } from '@shared/types/settings'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export function TrackerSyncDetails({
  kind,
  message,
  busy,
}: {
  kind: 'effective' | 'blacklist'
  message?: string
  busy: boolean
}) {
  const { t, i18n } = useTranslation()
  const { list, error } = useTrackerList()
  const [settings, setSettings] = useState<TrackerSettings | null>(null)
  const [open, setOpen] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [retryFailed, setRetryFailed] = useState(false)
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(50)
  useTransportMirror({
    events: [],
    refreshOnSettingsSave: true,
    load: async (stale, read) => {
      const next = (await read(Queries.GetSettings)) as AppSettings
      if (!stale()) setSettings(next.tracker)
    },
  })
  const date = (value: number | null | undefined) =>
    value == null ? '—' : new Date(value).toLocaleString(i18n.language)
  const blacklist = kind === 'blacklist'
  const sources =
    (blacklist ? settings?.blacklistSources : settings?.sources)?.filter(
      (s) => s.enabled
    ) ?? []
  const enabled = blacklist
    ? settings?.blacklistEnabled
    : settings?.sourcesEnabled
  const rows = sources.map((source) => {
    const stored =
      list.snapshots?.[`${blacklist ? 'blacklist' : 'tracker'}:${source.id}`]
    const snapshot = stored?.url === source.url ? stored : undefined
    const state =
      snapshot?.lastSuccessAt == null
        ? snapshot?.error
          ? 'failed'
          : 'pending'
        : Date.now() - snapshot.lastSuccessAt > TRACKER_SOURCE_MAX_AGE_MS
          ? 'expired'
          : snapshot.error
            ? 'cached'
            : 'fresh'
    return { source, snapshot, state }
  })
  const failed = rows.filter(
    (row) => row.snapshot?.error || row.state === 'expired'
  )
  const count = blacklist ? list.blacklist.length : list.effective.length
  const summary =
    message ??
    (error
      ? t('trackers.sync.unavailable')
      : !settings
        ? '—'
        : !enabled
          ? t('trackers.sync.details.disabled')
          : !sources.length
            ? t('trackers.sync.details.noSources')
            : failed.length
              ? t('trackers.sync.details.attention', {
                  count,
                  failed: failed.length,
                })
              : t('trackers.sync.details.summary', {
                  count,
                  time: date(list.lastSyncAt),
                }))
  const candidates = (list.candidates ?? []).filter((row) =>
    row.url.toLowerCase().includes(search.toLowerCase())
  )
  async function retry() {
    setRetrying(true)
    setRetryFailed(false)
    try {
      await transport.invoke(Commands.RetryTrackerSources)
    } catch {
      setRetryFailed(true)
    } finally {
      setRetrying(false)
    }
  }
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="truncate" title={summary}>
        {summary}
      </span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={t('trackers.sync.details.title')}
            />
          }
        >
          <InfoIcon />
        </DialogTrigger>
        <DialogContent
          className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-[700px]"
          initialFocus={false}
        >
          <DialogHeader className="shrink-0 px-6 pt-6 pb-4">
            <DialogTitle>{t('trackers.sync.details.title')}</DialogTitle>
            <DialogDescription>
              {t('trackers.sync.details.scope')}
            </DialogDescription>
          </DialogHeader>
          <Tabs
            key={kind}
            defaultValue="sources"
            className="flex min-h-0 flex-1 flex-col px-6"
          >
            <TabsList className="shrink-0 bg-tab-background">
              <TabsTrigger value="sources">
                {t('trackers.sync.details.sources')}
              </TabsTrigger>
              {!blacklist && (
                <TabsTrigger value="candidates">
                  {t('trackers.sync.details.candidates')}
                </TabsTrigger>
              )}
              <TabsTrigger value="history">
                {t('trackers.sync.details.history')}
              </TabsTrigger>
            </TabsList>
            <ScrollArea className="mt-4 min-h-0 flex-1">
              <ScrollAreaViewport className="max-h-[55vh] overscroll-contain">
                <ScrollAreaContent>
                  <TabsContent value="sources" className="m-0 space-y-4 pb-4">
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-xs">
                      <div>
                        <dt className="text-muted-foreground">
                          {t('trackers.sync.details.lastAttempt')}
                        </dt>
                        <dd className="mt-1">{date(list.lastAttemptAt)}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">
                          {t('trackers.sync.details.nextCheck')}
                        </dt>
                        <dd className="mt-1">
                          {settings?.autoSync
                            ? date(list.nextCheckAt)
                            : t('trackers.sync.details.autoOff')}
                        </dd>
                      </div>
                    </dl>
                    {list.pendingEngineApply && (
                      <p className="text-xs text-muted-foreground">
                        {t('trackers.sync.details.enginePending')}
                      </p>
                    )}
                    <div className="divide-y rounded-lg border border-border">
                      {rows.map(({ source, snapshot, state }) => (
                        <div
                          key={source.id}
                          className="space-y-1.5 px-3 py-3 text-xs"
                        >
                          <div className="flex items-start justify-between gap-4">
                            <span className="min-w-0 truncate font-medium">
                              {source.label}
                            </span>
                            <span className="shrink-0 text-muted-foreground">
                              {t(`trackers.sync.details.state.${state}`)}
                            </span>
                          </div>
                          <p className="text-muted-foreground">
                            {t('trackers.sync.details.sourceResult', {
                              count: snapshot?.urls.length ?? 0,
                              time: date(snapshot?.lastSuccessAt),
                            })}
                          </p>
                          {snapshot?.error && (
                            <p className="text-muted-foreground">
                              {t(
                                `trackers.sync.details.failure.${snapshot.error}`
                              )}
                            </p>
                          )}
                          {snapshot?.nextRetryAt && settings?.autoSync && (
                            <p className="text-muted-foreground">
                              {t('trackers.sync.details.retryAt', {
                                time: date(snapshot.nextRetryAt),
                              })}
                            </p>
                          )}
                        </div>
                      ))}
                      {!rows.length && (
                        <p className="p-4 text-xs text-muted-foreground">
                          {t('trackers.sync.details.noSources')}
                        </p>
                      )}
                    </div>
                  </TabsContent>
                  <TabsContent
                    value="candidates"
                    className="m-0 space-y-3 pb-4"
                  >
                    <p className="text-xs text-muted-foreground">
                      {t('trackers.sync.details.evidence')}
                    </p>
                    <Input
                      aria-label={t('panel.trackers.searchPlaceholder')}
                      placeholder={t('panel.trackers.searchPlaceholder')}
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value)
                        setLimit(50)
                      }}
                    />
                    <div className="divide-y rounded-lg border border-border">
                      {candidates.slice(0, limit).map((row) => (
                        <div
                          key={row.url}
                          className="space-y-1 px-3 py-2 text-xs"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <span className="min-w-0 break-all">{row.url}</span>
                            <span className="shrink-0 text-muted-foreground">
                              {t(`trackers.sync.details.reason.${row.reason}`)}
                            </span>
                          </div>
                          <p className="text-muted-foreground">
                            {t('trackers.sync.details.firstSeen', {
                              time: date(row.firstSeenAt),
                            })}
                          </p>
                        </div>
                      ))}
                      {!candidates.length && (
                        <p className="p-4 text-xs text-muted-foreground">
                          {t('trackers.sync.details.noCandidates')}
                        </p>
                      )}
                    </div>
                    {limit < candidates.length && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setLimit((n) => n + 50)}
                      >
                        {t('trackers.sync.details.showMore')}
                      </Button>
                    )}
                  </TabsContent>
                  <TabsContent value="history" className="m-0 pb-4">
                    <div className="divide-y rounded-lg border border-border">
                      {(list.history ?? []).map((run) => (
                        <div
                          key={run.id}
                          className="space-y-1.5 px-3 py-3 text-xs"
                        >
                          <div className="flex justify-between gap-3">
                            <span>
                              {t(
                                `trackers.sync.details.outcome.${run.outcome}`
                              )}
                            </span>
                            <span className="text-muted-foreground">
                              {date(run.finishedAt)}
                            </span>
                          </div>
                          <p className="text-muted-foreground">
                            {t('trackers.sync.details.run', {
                              success: run.successfulSources,
                              failed: run.failedSources,
                              added: run.added,
                              removed: run.removed,
                            })}
                          </p>
                        </div>
                      ))}
                      {!list.history?.length && (
                        <p className="p-4 text-xs text-muted-foreground">
                          {t('trackers.sync.details.noHistory')}
                        </p>
                      )}
                    </div>
                  </TabsContent>
                </ScrollAreaContent>
              </ScrollAreaViewport>
              <ScrollBar />
            </ScrollArea>
          </Tabs>
          <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
            {retryFailed && (
              <p role="alert" className="text-xs text-destructive">
                {t('trackers.sync.failed')}
              </p>
            )}
            {rows.some((row) => row.snapshot?.error) && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || retrying || !enabled}
                onClick={retry}
              >
                {t('trackers.sync.details.retry')}
              </Button>
            )}
            <Button size="sm" onClick={() => setOpen(false)}>
              {t('common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
