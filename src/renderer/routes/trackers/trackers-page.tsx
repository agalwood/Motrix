import { PanelShell } from '@renderer/components/desktop-kit/panel/panel-shell'
import { Button } from '@renderer/components/ui/button'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@renderer/components/ui/tabs'
import { useSyncTrackers } from '@renderer/hooks/use-sync-trackers'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BlacklistTrackerPanel } from './components/blacklist-tracker-panel'
import { EffectiveTrackerPanel } from './components/effective-tracker-panel'

export function TrackersPage() {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'effective' | 'blacklist'>('effective')
  const { sync, isSyncing } = useSyncTrackers()

  return (
    <PanelShell
      title={t('panel.trackers.title')}
      search={{
        value: search,
        onChange: setSearch,
        placeholder: t('panel.trackers.searchPlaceholder'),
      }}
      footer={
        <>
          <div />
          <Button type="button" onClick={sync} disabled={isSyncing} size="sm">
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
        className="flex min-h-0 flex-1"
      >
        <TabsList className="shrink-0 bg-tab-background">
          <TabsTrigger value="effective">
            {t('panel.trackers.tab.effective')}
          </TabsTrigger>
          <TabsTrigger value="blacklist">
            {t('panel.trackers.tab.blacklist')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="effective" className="mt-2 flex min-h-0 flex-1">
          <EffectiveTrackerPanel filter={search} />
        </TabsContent>
        <TabsContent value="blacklist" className="mt-2 flex min-h-0 flex-1">
          <BlacklistTrackerPanel filter={search} />
        </TabsContent>
      </Tabs>
    </PanelShell>
  )
}
