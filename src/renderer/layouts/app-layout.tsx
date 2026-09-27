import { AddTaskDialogHost } from '@renderer/components/add-task-dialog/add-task-dialog-host'
import { AppSidebar } from '@renderer/components/desktop-kit/sidebar/app-sidebar'
import { SidebarInset, SidebarProvider } from '@renderer/components/ui/sidebar'
import { Toaster } from '@renderer/components/ui/toast'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { WebConnectionNotice } from '@renderer/components/web-connection-notice'
import { AddTaskTriggerButton } from '@renderer/components/window-chrome/add-task-trigger-button'
import { MotrixMenuButton } from '@renderer/components/window-chrome/motrix-menu-button'
import { SidebarTriggerButton } from '@renderer/components/window-chrome/sidebar-trigger-button'
import { WindowChrome } from '@renderer/components/window-chrome/window-chrome'
import { DesktopMenuActions } from '@renderer/features/application-menu/desktop-menu-actions'
import { MenuNavigationFocus } from '@renderer/features/application-menu/navigation-focus'
import { EngineDiagnosticsDialogHost } from '@renderer/features/engine-diagnostics/engine-diagnostics-dialog'
import { useEngineRestartRequiredToast } from '@renderer/hooks/use-engine-restart-required-toast'
import { useIpcEvent } from '@renderer/hooks/use-ipc-event'
import { useMenuContextSync } from '@renderer/hooks/use-menu-context-sync'
import { useNotificationToasts } from '@renderer/hooks/use-notification-toasts'
import { useSidebarColor } from '@renderer/hooks/use-sidebar-color'
import { useToastEvents } from '@renderer/hooks/use-toast-events'
import { cn } from '@renderer/lib/utils'
import { electronServices } from '@renderer/platform/electron-services'
import { PlatformServicesProvider } from '@renderer/platform/services'
import { webServices } from '@renderer/platform/web-services'
import type { RouteHandle } from '@renderer/router-types'
import { RemoveTasksDialogHost } from '@renderer/routes/downloads/inspector/remove-tasks-dialog-host'
import { useDownloadsSelection } from '@renderer/routes/downloads/store'
import { useDownloadsView } from '@renderer/routes/downloads/view-preferences'
import { usePairRequestPrompts } from '@renderer/routes/settings/cards/integration/use-pair-request-prompts'
import { ALL_DOWNLOADS_ROUTE } from '@shared/lib/task-navigation'
import { Events } from '@shared/protocol/events'
import { Outlet, useMatches, useNavigate } from 'react-router'

const platformServices =
  __MOTRIX_TARGET__ === 'electron' ? electronServices : webServices

function DesktopMenuContext() {
  useMenuContextSync()
  return <DesktopMenuActions />
}

export function AppLayout() {
  useSidebarColor()
  useToastEvents()
  usePairRequestPrompts()
  useEngineRestartRequiredToast()
  useNotificationToasts()

  const navigate = useNavigate()
  const matches = useMatches()
  const transparentInset = matches.some(
    (m) => (m.handle as RouteHandle | undefined)?.transparentInset
  )
  useIpcEvent(Events.NavigateTo, (...args) => {
    const path = args[0]
    if (typeof path !== 'string' || !path) return
    if (path === ALL_DOWNLOADS_ROUTE) {
      // A deleted-task fallback must not leave another task's details open.
      useDownloadsView.getState().setInspectorVisible(false)
      useDownloadsSelection.getState().clearSelection()
    }
    navigate(path)
  })

  return (
    <TooltipProvider>
      <PlatformServicesProvider services={platformServices}>
        {/* Unconditional bg-sidebar: below the md breakpoint the Sidebar
            renders as a portaled Sheet without data-variant="inset", so the
            wrapper's built-in has-data-[variant=inset]:bg-sidebar stops
            matching and transparent-inset pages would fall through to the
            white body background. */}
        <SidebarProvider
          className={cn(
            'h-svh overflow-hidden bg-sidebar',
            __MOTRIX_TARGET__ === 'web' && 'web-window-chrome',
            __MOTRIX_TARGET__ === 'electron' && 'electron-window-chrome',
            __MOTRIX_TARGET__ === 'electron' &&
              __MOTRIX_PREVIEW_MAC_MENU__ &&
              'preview-desktop-window-controls'
          )}
        >
          <WindowChrome
            variant="overlay"
            leading={<MotrixMenuButton />}
            previewDesktopControls={__MOTRIX_PREVIEW_MAC_MENU__}
          >
            <div className="flex items-center gap-1.5">
              <SidebarTriggerButton />
              <AddTaskTriggerButton />
            </div>
          </WindowChrome>
          <AppSidebar />
          <SidebarInset
            className={cn(
              'min-h-0 overflow-hidden bg-sidebar-inset',
              // Keep the inset card look below the md breakpoint too —
              // upstream gates these behind md:peer-data-[variant=inset]:,
              // which stops matching once the sidebar renders as a Sheet.
              // At md+ the built-in ms-0 / collapsed ms-2 still win over
              // m-2 (Tailwind orders ms-* after m-*).
              'm-2 rounded-xl shadow-sm',
              // Suppress BOTH shadow forms: tailwind-merge only collapses
              // identical-modifier classes, so a bare shadow-none would
              // leave the component's built-in
              // md:peer-data-[variant=inset]:shadow-sm alive at md+.
              transparentInset &&
                'bg-transparent shadow-none md:peer-data-[variant=inset]:shadow-none'
            )}
          >
            <div className="min-h-0 flex-1 overflow-hidden">
              <Outlet />
            </div>
            <WebConnectionNotice />
          </SidebarInset>
        </SidebarProvider>
        {__MOTRIX_TARGET__ === 'electron' && <DesktopMenuContext />}
        <MenuNavigationFocus />
        <RemoveTasksDialogHost />
        <EngineDiagnosticsDialogHost />
        {__MOTRIX_TARGET__ === 'web' && <AddTaskDialogHost />}
      </PlatformServicesProvider>
      <Toaster />
    </TooltipProvider>
  )
}
