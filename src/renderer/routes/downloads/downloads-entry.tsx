import { useTransportMirror } from '@renderer/hooks/use-transport-mirror'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import {
  appSettingsSchema,
  type DownloadsOpeningView,
} from '@shared/schemas/app-settings'
import type { AppSettings } from '@shared/types/settings'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useLocation, useOutletContext } from 'react-router'
import { lastSelectedDownloadsTab } from './last-selected-tab'

/** The shell keeps the last confirmed policy available across visits and reconnects. */
export function useDownloadsOpeningView() {
  const [view, setView] = useState<DownloadsOpeningView>()
  useTransportMirror({
    events: [Events.DownloadsOpeningViewChanged],
    refreshOnSettingsSave: true,
    load: async (stale, read) => {
      try {
        const settings = (await read(Queries.GetSettings)) as AppSettings
        if (!stale())
          setView(
            appSettingsSchema.shape.downloadsOpeningView.parse(
              settings?.app?.downloadsOpeningView
            )
          )
      } catch (error) {
        if (!stale()) setView((previous) => previous ?? 'remember')
        throw error
      }
    },
  })
  return view
}

export function DownloadsEntry() {
  const { t } = useTranslation()
  const { search, hash, state } = useLocation()
  const view = useOutletContext<DownloadsOpeningView | undefined>()
  const hasTask = new URLSearchParams(search).has('task')
  const tab = hasTask
    ? 'all'
    : view === 'remember'
      ? lastSelectedDownloadsTab()
      : view
  return tab ? (
    <Navigate
      replace
      state={state}
      to={{ pathname: `/downloads/${tab}`, search, hash }}
    />
  ) : (
    <p role="status" className="px-6 py-4 text-sm text-muted-foreground">
      {t('common.loading')}
    </p>
  )
}
