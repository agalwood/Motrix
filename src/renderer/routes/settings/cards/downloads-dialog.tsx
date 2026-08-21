import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Form } from '@renderer/components/ui/form'
import { Separator } from '@renderer/components/ui/separator'
import { pickDirty } from '@renderer/lib/form-utils'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { DEFAULT_SPEED_LIMIT_SETTINGS } from '@shared/schemas/speed-limit'
import type { AppSettings } from '@shared/types/settings'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { SettingsCardDialogProps } from './card-types'
import {
  DOWNLOADS_DEFAULTS,
  type DownloadsFields,
  ENGINE_DEFAULTS,
} from './downloads-form'
import { EngineTuningSection } from './engine-tuning-section'
import { PerformanceSection } from './performance-section'
import { SpeedLimitSection } from './speed-limit-section'

// Form shape, defaults, and unit constants live in ./downloads-form.ts. The
// compact sections are ordered by user intent: performance, limits, then
// advanced engine behavior.

export function DownloadsDialog({
  open,
  onClose,
  labelKey,
  descKey,
}: SettingsCardDialogProps) {
  const { t } = useTranslation()
  const form = useForm<DownloadsFields>({ defaultValues: DOWNLOADS_DEFAULTS })

  // biome-ignore lint/correctness/useExhaustiveDependencies: form is stable across renders; this is a mount-only fetch
  useEffect(() => {
    let cancelled = false
    transport
      .invoke(Queries.GetSettings)
      .then((data) => {
        if (cancelled) return
        const all = data as AppSettings
        form.reset({
          engine: all?.engine
            ? { ...ENGINE_DEFAULTS, ...all.engine }
            : ENGINE_DEFAULTS,
          speedLimit: all?.speedLimit
            ? { ...DEFAULT_SPEED_LIMIT_SETTINGS, ...all.speedLimit }
            : DEFAULT_SPEED_LIMIT_SETTINGS,
        })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const onSubmit = form.handleSubmit(async (values) => {
    // pickDirty recurses the dirty-fields tree: if speedLimit.base.download
    // is dirty, it returns { speedLimit: { base: { download: <new> } } }.
    // We then spread the engine dirty patch back into { engine: ... } and pass
    // the whole thing to UpdateSettings. SettingsManager deep-merges each
    // top-level namespace, so partial patches for both engine and speedLimit
    // are safe.
    // biome-ignore lint/suspicious/noExplicitAny: dirtyFields shape doesn't fit DirtyTree; cast is safe
    const dirty = pickDirty(values, form.formState.dirtyFields as any)
    if (!dirty) {
      onClose()
      return
    }
    await transport.invoke(Commands.UpdateSettings, dirty)
    onClose()
  })

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-[700px]"
        initialFocus={false}
      >
        <DialogHeader className="shrink-0 px-6 pt-6">
          <DialogTitle>{t(labelKey)}</DialogTitle>
          <DialogDescription>{t(descKey)}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <Form {...form}>
            <form className="space-y-4">
              <PerformanceSection form={form} />
              <Separator className="my-4" />
              <SpeedLimitSection form={form} />
              <Separator className="my-4" />
              <EngineTuningSection form={form} />
            </form>
          </Form>
        </div>

        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onSubmit}
            disabled={form.formState.isSubmitting}
          >
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
