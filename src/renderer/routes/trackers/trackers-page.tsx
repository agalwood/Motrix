import { PanelShell } from '@renderer/components/desktop-kit/panel/panel-shell'
import { Toolbar } from '@renderer/components/desktop-kit/toolbar/toolbar'
import { ToolbarSearch } from '@renderer/components/desktop-kit/toolbar/toolbar-search'
import { LoadingIcon } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@renderer/components/ui/tabs'
import { useSyncTrackers } from '@renderer/hooks/use-sync-trackers'
import { cn } from '@renderer/lib/utils'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BlacklistTrackerPanel } from './components/blacklist-tracker-panel'
import { EffectiveTrackerPanel } from './components/effective-tracker-panel'

export function TrackersPage() {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'effective' | 'blacklist'>('effective')
  const { sync, isSyncing, status, error } = useSyncTrackers()
  const syncMessage = isSyncing
    ? status === 'probing'
      ? t('trackers.sync.probing')
      : status === 'applying'
        ? t('trackers.sync.applying')
        : t('trackers.sync.fetching')
    : undefined

  return (
    <PanelShell
      title={t('panel.trackers.title')}
      actions={
        <Toolbar label={t('panel.trackers.title')}>
          <ToolbarSearch
            value={search}
            onValueChange={setSearch}
            label={t('panel.trackers.searchPlaceholder')}
            clearLabel={t('common.clearSearch')}
          />
        </Toolbar>
      }
      actionsDraggable
      actionsClassName="min-w-0 flex-1"
      footer={
        <>
          <div
            role="status"
            className={cn(
              'min-w-0 text-xs text-muted-foreground',
              error && 'text-destructive'
            )}
          >
            {syncMessage ??
              (error === 'failed'
                ? t('trackers.sync.failed')
                : error === 'unavailable'
                  ? t('trackers.sync.unavailable')
                  : null)}
          </div>
          <Button
            type="button"
            onClick={sync}
            disabled={isSyncing}
            size="sm"
            className="shrink-0"
          >
            {isSyncing && (
              <LoadingIcon
                className="size-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            )}
            {isSyncing
              ? t('trackers.sync.syncing')
              : t('panel.trackers.syncNow')}
          </Button>
        </>
      }
      contentClassName="px-6"
    >
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as 'effective' | 'blacklist')}
        className="flex min-h-0 min-w-0 flex-1"
      >
        <TabsList className="shrink-0 bg-tab-background">
          <TabsTrigger value="effective">
            {t('panel.trackers.tab.effective')}
          </TabsTrigger>
          <TabsTrigger value="blacklist">
            {t('panel.trackers.tab.blacklist')}
          </TabsTrigger>
        </TabsList>
        <TabsContent
          value="effective"
          className="mt-2 flex min-h-0 min-w-0 flex-1"
        >
          <EffectiveTrackerPanel filter={search} syncMessage={syncMessage} />
        </TabsContent>
        <TabsContent
          value="blacklist"
          className="mt-2 flex min-h-0 min-w-0 flex-1"
        >
          <BlacklistTrackerPanel filter={search} syncMessage={syncMessage} />
        </TabsContent>
      </Tabs>
    </PanelShell>
  )
}
