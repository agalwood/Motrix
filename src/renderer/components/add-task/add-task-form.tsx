import { zodResolver } from '@hookform/resolvers/zod'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@renderer/components/ui/tabs'
import { transport } from '@renderer/lib/transport'
import { usePlatformServices } from '@renderer/platform/services'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  type AddTaskFormValues,
  addTaskFormSchema,
  formValuesToTaskCreateRequests,
} from '@shared/schemas/add-task'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  type DeepPartial,
  FormProvider,
  type Resolver,
  useForm,
  useFormContext,
  useWatch,
} from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { FooterActions } from './footer-actions'
import { LinksTabPanel } from './links-tab-panel'
import { TorrentTabPanel } from './torrent-tab-panel'
import { parseUrlLines } from './url-interpreters/multiline-url'
import { useExternalHydration } from './use-external-hydration'

interface AddTaskFormProps {
  defaultValues?: DeepPartial<AddTaskFormValues>
  onSubmitSuccess?: (gid: string) => void
  onCancel: () => void
  subscribeEvents?: boolean
}

const BASE_DEFAULTS: DeepPartial<AddTaskFormValues> = {
  tab: 'links',
  urls: '',
  saveDir: '',
  split: 5,
}

export function AddTaskForm({
  defaultValues,
  onSubmitSuccess,
  onCancel,
  subscribeEvents = true,
}: AddTaskFormProps) {
  const platform = usePlatformServices()
  const [submitting, setSubmitting] = useState(false)

  const form = useForm<AddTaskFormValues>({
    resolver: zodResolver(addTaskFormSchema) as Resolver<AddTaskFormValues>,
    mode: 'onTouched',
    defaultValues: { ...BASE_DEFAULTS, ...defaultValues } as AddTaskFormValues,
  })

  const clipboardAutofillRequest = useRef(0)

  // Read once for each actual open. The desktop add-task window is precreated
  // while hidden, so only its user-triggered SetAddTaskMode event starts a
  // read; an in-page dialog is already visible when this form mounts.
  const autofillClipboardLinks = useCallback(async () => {
    const request = ++clipboardAutofillRequest.current
    if (form.getValues('tab') !== 'links') return
    if (form.getValues('urls')) return
    try {
      const settings = (await transport.invoke(Queries.GetSettings)) as {
        app?: { autofillClipboardLinks?: boolean }
      }
      if (
        request !== clipboardAutofillRequest.current ||
        settings?.app?.autofillClipboardLinks === false
      ) {
        return
      }
      const content = (await platform.readClipboard()).trim()
      if (request !== clipboardAutofillRequest.current || !content) return
      const lines = parseUrlLines(content)
      if (lines.length === 0 || !lines.every((line) => line.valid)) return
      if (form.getValues('urls')) return
      form.setValue(
        'urls' as never,
        lines.map((line) => line.url).join('\n') as never,
        { shouldValidate: true }
      )
    } catch {
      // Best effort — the clipboard may be unreadable (web permissions).
    }
  }, [form, platform])

  useExternalHydration(form, subscribeEvents, autofillClipboardLinks)

  // Backfill saveDir from user settings when nothing populated it via
  // URL params or an external hydration event. Without this the form
  // starts with "" and silently fails Zod min(1) validation on submit.
  useEffect(() => {
    if (form.getValues('saveDir')) return
    let cancelled = false
    ;(async () => {
      try {
        const settings = (await transport.invoke(Queries.GetSettings)) as {
          app?: { defaultSaveDir?: string }
        }
        const dir = settings?.app?.defaultSaveDir
        if (!cancelled && dir && !form.getValues('saveDir')) {
          form.setValue('saveDir' as never, dir as never, {
            shouldValidate: false,
          })
        }
      } catch {
        // Best effort — user can still pick a folder manually.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [form])

  // Only immediately visible in-page dialogs read on mount. Desktop opens are
  // triggered by useExternalHydration after SetAddTaskMode resets the
  // precreated form, so precreation never accesses the clipboard and external
  // prefill always wins.
  useEffect(() => {
    if (!subscribeEvents) void autofillClipboardLinks()
    return () => {
      clipboardAutofillRequest.current += 1
    }
  }, [autofillClipboardLinks, subscribeEvents])

  const onSubmit = useCallback(
    async (values: AddTaskFormValues) => {
      setSubmitting(true)
      try {
        const requests = formValuesToTaskCreateRequests(values)
        const gids: string[] = []
        let failed = 0
        for (const request of requests) {
          try {
            const result = (await transport.invoke(
              Commands.CreateTask,
              request
            )) as { gid: string }
            gids.push(result.gid)
          } catch (err) {
            failed += 1
            console.error(err)
          }
        }
        if (failed === 0) {
          platform.notify('info', 'task.add.created')
        } else if (gids.length > 0) {
          platform.notify('warn', 'task.add.createdPartial', {
            ok: gids.length,
            failed,
          })
        } else {
          platform.notify('error', 'task.add.createFailed')
        }
        if (gids.length > 0) onSubmitSuccess?.(gids[0])
      } finally {
        setSubmitting(false)
      }
    },
    [platform, onSubmitSuccess]
  )

  // ⌘↵ / Ctrl+Enter submit
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void form.handleSubmit(onSubmit)()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [form, onSubmit])

  return (
    <FormProvider {...form}>
      <div className="flex max-h-[calc(100vh-40px)] flex-col overflow-y-auto">
        <div data-adaptive-content className="px-4 pt-2 pb-[72px]">
          <TabsSection />
        </div>
      </div>
      <div className="fixed left-0 bottom-0 w-full shrink-0 border-t-[0.5px] border-border bg-background px-4 py-3">
        <FooterActionsBridge
          onCancel={onCancel}
          onSubmit={() => void form.handleSubmit(onSubmit)()}
          submitting={submitting}
        />
      </div>
    </FormProvider>
  )
}

function TabsSection() {
  const { t } = useTranslation()
  const { setValue } = useFormContext<AddTaskFormValues>()
  const tab = useWatch<AddTaskFormValues, 'tab'>({ name: 'tab' })
  return (
    <Tabs
      value={tab ?? 'links'}
      onValueChange={(v) =>
        setValue('tab' as never, v as never, { shouldDirty: true })
      }
      className="flex min-h-0 flex-1 flex-col"
    >
      <TabsList className="shrink-0 bg-tab-background">
        <TabsTrigger value="links">{t('task.add.links')}</TabsTrigger>
        <TabsTrigger value="torrent">{t('task.add.torrent')}</TabsTrigger>
      </TabsList>
      <TabsContent
        value="links"
        keepMounted
        className="mt-2 flex min-h-0 min-w-0 flex-1 data-hidden:hidden"
      >
        <LinksTabPanel />
      </TabsContent>
      <TabsContent
        value="torrent"
        keepMounted
        className="mt-2 flex min-h-0 min-w-0 flex-1 data-hidden:hidden"
      >
        <TorrentTabPanel />
      </TabsContent>
    </Tabs>
  )
}

function FooterActionsBridge({
  onCancel,
  onSubmit,
  submitting,
}: {
  onCancel: () => void
  onSubmit: () => void
  submitting: boolean
}) {
  const tab = useWatch<AddTaskFormValues, 'tab'>({ name: 'tab' })
  const urls = useWatch<AddTaskFormValues, 'urls'>({ name: 'urls' })
  const saveDir = useWatch<AddTaskFormValues, 'saveDir'>({ name: 'saveDir' })
  const selectedFiles = useWatch<AddTaskFormValues, 'selectedFiles'>({
    name: 'selectedFiles',
  })
  const torrentMeta = useWatch<AddTaskFormValues, 'torrentMeta'>({
    name: 'torrentMeta',
  })

  const hasSaveDir = Boolean((saveDir ?? '').trim())
  const canSubmit =
    hasSaveDir &&
    (tab === 'links'
      ? Boolean((urls ?? '').trim())
      : Boolean(torrentMeta) && (selectedFiles ?? []).length > 0)

  return (
    <FooterActions
      submitting={submitting}
      canSubmit={canSubmit}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />
  )
}
