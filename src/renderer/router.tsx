import { createHashRouter, Navigate, type RouteObject } from 'react-router'
import { AppLayout } from './layouts/app-layout'
import type { RouteHandle } from './router-types'
import { DashboardPage } from './routes/dashboard/dashboard-page'
import { DownloadsPage } from './routes/downloads/downloads-page'
import { NotificationsPage } from './routes/notifications/notifications-page'
import { PluginDetailPage } from './routes/plugins/plugin-detail-page'
import { PluginDiagnosticsPage } from './routes/plugins/plugin-diagnostics-page'
import { PluginsPage } from './routes/plugins/plugins-page'
import { SettingsPage } from './routes/settings/settings-page'
import { TrackersPage } from './routes/trackers/trackers-page'

const routes = [
  {
    path: '/',
    element: <AppLayout />,
    children: [
      {
        index: true,
        element: <DashboardPage />,
        handle: { transparentInset: true } satisfies RouteHandle,
      },
      {
        path: 'downloads',
        element: <DownloadsPage />,
        children: [
          { index: true, element: <Navigate to="all" replace /> },
          { path: ':filter', element: null },
        ],
      },
      { path: 'trackers', element: <TrackersPage /> },
      { path: 'plugins', element: <PluginsPage /> },
      {
        path: 'plugins/diagnostics',
        element: <PluginDiagnosticsPage />,
      },
      { path: 'plugins/:id', element: <PluginDetailPage /> },
      { path: 'notifications', element: <NotificationsPage /> },
      {
        path: 'settings',
        element: <SettingsPage />,
        children: [{ path: ':cardId', element: null }],
      },
    ],
  },
] satisfies RouteObject[]

export const router = createHashRouter(routes)
