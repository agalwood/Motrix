import { PanelShell } from '@renderer/components/desktop-kit/panel/panel-shell'
import { OnboardingLanguageSelect } from '@renderer/components/onboarding/onboarding-language-select'
import { PluginConfigField } from '@renderer/components/settings-kit/plugin-config-field'
import { DirectionProvider } from '@renderer/components/ui/direction'
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
} from '@renderer/components/ui/sidebar'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { AddTaskTriggerButton } from '@renderer/components/window-chrome/add-task-trigger-button'
import { MotrixMenuButton } from '@renderer/components/window-chrome/motrix-menu-button'
import { SidebarTriggerButton } from '@renderer/components/window-chrome/sidebar-trigger-button'
import { WindowChrome } from '@renderer/components/window-chrome/window-chrome'
import { WindowControlsOverlayProvider } from '@renderer/components/window-chrome/window-controls-overlay-provider'
import { applyRendererLocale } from '@renderer/lib/i18n'
import { DownloadsToolbar } from '@renderer/routes/downloads/downloads-toolbar'
import {
  countTasksByTab,
  countTasksByType,
  type DownloadsTab,
} from '@renderer/routes/downloads/filter'
import { StatusTitleMenu } from '@renderer/routes/downloads/status-title-menu'
import { useDownloadsSelection } from '@renderer/routes/downloads/store'
import './harness.css'
import { WINDOW_CONTROLS_OVERLAY_HEIGHT } from '@shared/constants/window-chrome'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import type { TaskType } from '@shared/types/task'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { FormProvider, useForm } from 'react-hook-form'
import { MemoryRouter } from 'react-router'

declare global {
  interface Window {
    windowChromeFixture: { commands: string[] }
  }
}

const params = new URLSearchParams(location.search)
const platform = params.get('platform') ?? 'linux'
const mode = params.get('mode') ?? 'main'
const expanded = params.has('expanded')
const dir = params.get('dir') === 'rtl' ? 'rtl' : 'ltr'
const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
class FixtureOverlay extends EventTarget {
  visible = !params.has('fullscreen')
  getTitlebarAreaRect() {
    return new DOMRect(
      0,
      0,
      innerWidth,
      this.visible ? WINDOW_CONTROLS_OVERLAY_HEIGHT : 0
    )
  }
}
const overlay = new FixtureOverlay()
Object.defineProperty(navigator, 'windowControlsOverlay', {
  value: overlay,
  configurable: true,
})
Object.assign(window, {
  windowChromeFixture: { commands: [] },
  motrix: {
    platform,
    invoke: async (channel: string) => {
      window.windowChromeFixture.commands.push(channel)
      if (channel === Queries.GetSettings)
        return { app: { liquidGlassEffect: false } }
      if (channel === Commands.GetPluginOperations) return { descriptors: [] }
      if (channel === Queries.GetDisclaimerState) return { language: 'system' }
      if (channel === Queries.GetApplicationMenu) {
        return {
          revision: 1,
          items: [
            {
              id: 'app.about',
              type: 'normal',
              label: 'About Motrix',
              enabled: true,
              visible: true,
            },
          ],
        }
      }
      return undefined
    },
    on(channel: string, listener: (...args: unknown[]) => void) {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)?.add(listener)
      return () => listeners.get(channel)?.delete(listener)
    },
  },
})
window.addEventListener('fixture-fullscreen', (event) => {
  overlay.visible = !(event as CustomEvent).detail
  overlay.dispatchEvent(new Event('geometrychange'))
  for (const listener of listeners.get(Events.WindowMaximizedChanged) ?? []) {
    listener({ maximized: false, fullscreen: (event as CustomEvent).detail })
  }
})
document.documentElement.className = `platform-${platform} window-${mode}`
await applyRendererLocale('en-US')
document.documentElement.dir = dir

function MainWindow() {
  const [query, setQuery] = useState('')
  const [types, setTypes] = useState<TaskType[]>([])
  const [tab, setTab] = useState<DownloadsTab>('all')
  return (
    <SidebarProvider
      defaultOpen={expanded}
      className="electron-window-chrome h-svh overflow-hidden bg-sidebar"
    >
      <WindowChrome variant="overlay" leading={<MotrixMenuButton />}>
        <div className="flex items-center gap-1.5">
          <SidebarTriggerButton />
          <AddTaskTriggerButton />
        </div>
      </WindowChrome>
      <Sidebar variant="inset" side={dir === 'rtl' ? 'right' : 'left'}>
        <SidebarHeader style={{ height: 45 }} />
        <SidebarContent />
      </Sidebar>
      <SidebarInset className="m-2 min-h-0 overflow-hidden rounded-xl bg-sidebar-inset">
        <PanelShell
          title={
            <StatusTitleMenu
              tab={tab}
              onTabChange={setTab}
              counts={countTasksByTab([])}
            />
          }
          actions={
            <DownloadsToolbar
              tasks={[]}
              selection={useDownloadsSelection}
              onHideInspector={() => {}}
              query={query}
              onQueryChange={setQuery}
              types={types}
              onTypesChange={setTypes}
              typeCounts={countTasksByType([])}
            />
          }
          actionsDraggable
          headerClassName="compact-header:py-1"
          actionsClassName="min-w-0 flex-1"
        >
          <div data-testid="panel-content">Download list</div>
        </PanelShell>
      </SidebarInset>
    </SidebarProvider>
  )
}

function PluginSettings() {
  const form = useForm({ defaultValues: { choice: 'Option 15' } })
  return (
    <FormProvider {...form}>
      <div className="px-4 pt-20">
        <PluginConfigField
          name="choice"
          node={{
            type: 'string',
            enum: Array.from({ length: 30 }, (_, index) => `Option ${index}`),
          }}
        />
      </div>
    </FormProvider>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing fixture root')
createRoot(root).render(
  <MemoryRouter>
    <DirectionProvider direction={dir}>
      <TooltipProvider>
        <WindowControlsOverlayProvider>
          {mode === 'main' ? (
            <MainWindow />
          ) : mode === 'plugin-settings' ? (
            <PluginSettings />
          ) : (
            <div className="flex h-svh flex-col bg-background">
              <WindowChrome
                title={mode === 'add-task' ? 'New task' : 'Motrix'}
                maximizable={false}
                actionsPosition="end"
              >
                {mode === 'onboarding' && <OnboardingLanguageSelect />}
              </WindowChrome>
              <div data-testid="panel-content">Window content</div>
            </div>
          )}
        </WindowControlsOverlayProvider>
      </TooltipProvider>
    </DirectionProvider>
  </MemoryRouter>
)

// Inject only WCO geometry/hit regions: toolbar, popup and menu behavior is real.
for (const side of ['left', 'right'] as const) {
  const overlay = document.createElement('div')
  overlay.dataset.nativeOverlay = side
  Object.assign(overlay.style, {
    position: 'fixed',
    top: '0',
    [side]: '0',
    width: `var(--window-controls-overlay-${side})`,
    height: `${WINDOW_CONTROLS_OVERLAY_HEIGHT}px`,
    zIndex: '9999',
    background: '#808080',
    pointerEvents: platform === 'linux' ? 'auto' : 'none',
  })
  document.body.append(overlay)
}
