import { AddTaskForm } from '@renderer/components/add-task/add-task-form'
import { AddTaskDialogHost } from '@renderer/components/add-task-dialog/add-task-dialog-host'
import { useAddTaskDialogStore } from '@renderer/components/add-task-dialog/use-add-task-dialog-store'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { applyRendererLocale } from '@renderer/lib/i18n'
import { PlatformServicesProvider } from '@renderer/platform/services'
import { webServices } from '@renderer/platform/web-services'
import { DownloadsDialog } from '@renderer/routes/settings/cards/downloads-dialog'
import { GeneralDialog } from '@renderer/routes/settings/cards/general-dialog'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import { fixtureState } from './fixture-transport'
import './harness.css'

Object.assign(window, { directoryPickerFixture: fixtureState })
for (const type of ['focusin', 'keydown', 'keyup', 'click']) {
  document.addEventListener(
    type,
    (event) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      const active =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null
      fixtureState.interactions.push({
        type,
        key: event instanceof KeyboardEvent ? event.key : undefined,
        tag: target?.tagName,
        label:
          target?.getAttribute('aria-label') ??
          target?.textContent?.trim().slice(0, 80),
        time: performance.now(),
        activeTag: active?.tagName,
        activeLabel:
          active?.getAttribute('aria-label') ??
          active?.textContent?.trim().slice(0, 80),
      })
      if (fixtureState.interactions.length > 100)
        fixtureState.interactions.shift()
    },
    true
  )
}
const parameters = new URLSearchParams(location.search)
document.documentElement.classList.toggle(
  'dark',
  parameters.get('theme') === 'dark'
)
await applyRendererLocale('en-US')

// The App's form must inherit the native service fixture. The production Web
// AddTaskDialogHost intentionally owns a Web provider and cannot simulate it.
function AppFormFixture() {
  const { open, prefill, close } = useAddTaskDialogStore()
  return (
    <Dialog open={open} onOpenChange={(value) => !value && close()}>
      <DialogContent
        className="flex h-[420px] max-h-[90vh] flex-col"
        initialFocus={false}
      >
        <DialogHeader>
          <DialogTitle>New Task</DialogTitle>
        </DialogHeader>
        <AddTaskForm
          key={open ? 'open' : 'closed'}
          defaultValues={prefill}
          onCancel={close}
          onSubmitSuccess={close}
          presentation="dialog"
          subscribeEvents={false}
        />
      </DialogContent>
    </Dialog>
  )
}

function Harness() {
  const [generalOpen, setGeneralOpen] = useState(false)
  const [downloadsOpen, setDownloadsOpen] = useState(false)
  const services = parameters.has('nativePicker')
    ? {
        ...webServices,
        kind: 'electron' as const,
        pickSaveDir: async () => {
          fixtureState.nativePickerCalls++
          return fixtureState.nativePickerResult
        },
      }
    : webServices
  return (
    <MemoryRouter>
      <TooltipProvider>
        <PlatformServicesProvider services={services}>
          <main className="min-h-svh bg-background p-8 text-foreground">
            <Button
              onClick={() =>
                useAddTaskDialogStore.getState().openWith({
                  tab: 'links',
                  urls: 'https://example.com/archive.zip',
                  saveDir: '/downloads',
                })
              }
            >
              Open download dialog
            </Button>
            <Button
              onClick={() =>
                useAddTaskDialogStore.getState().openWith({
                  tab: 'torrent',
                  source: 'file',
                  base64: 'Zml4dHVyZQ==',
                  saveDir: '/downloads',
                  selectedFiles: [0],
                  torrentMeta: {
                    name: 'Fixture archive',
                    infoHash: 'a'.repeat(40),
                    totalSize: 1024,
                    files: [
                      {
                        index: 0,
                        path: 'archive.zip',
                        size: 1024,
                        extension: '.zip',
                      },
                    ],
                  },
                })
              }
            >
              Open torrent dialog
            </Button>
            <Button onClick={() => setGeneralOpen(true)}>
              Open General settings
            </Button>
            <Button onClick={() => setDownloadsOpen(true)}>
              Open Downloads settings
            </Button>
            {parameters.has('nativePicker') ? (
              <AppFormFixture />
            ) : (
              <AddTaskDialogHost />
            )}
            {generalOpen && (
              <GeneralDialog
                open
                onClose={() => {
                  fixtureState.interactions.push({
                    type: 'general-close',
                    time: performance.now(),
                    stack: new Error('General onClose').stack,
                  })
                  setGeneralOpen(false)
                }}
                labelKey="settings.cards.general.title"
                descKey="settings.cards.general.desc"
              />
            )}
            {downloadsOpen && (
              <DownloadsDialog
                open
                onClose={() => setDownloadsOpen(false)}
                labelKey="settings.cards.downloads.title"
                descKey="settings.cards.downloads.desc"
              />
            )}
          </main>
        </PlatformServicesProvider>
      </TooltipProvider>
    </MemoryRouter>
  )
}

const container = document.getElementById('root')
if (!container) throw new Error('Missing browser harness root')
createRoot(container).render(<Harness />)
