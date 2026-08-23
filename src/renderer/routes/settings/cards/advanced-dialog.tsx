import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from '@renderer/components/ui/form'
import { Input } from '@renderer/components/ui/input'
import { PasswordInput } from '@renderer/components/ui/password-input'
import { Separator } from '@renderer/components/ui/separator'
import { Switch } from '@renderer/components/ui/switch'
import { pickDirty } from '@renderer/lib/form-utils'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { DEFAULT_ENGINE_SETTINGS } from '@shared/schemas'
import type { AppSettings, EngineSettings } from '@shared/types/settings'
import { generateRpcSecret } from '@shared/utils/rpc-secret'
import { Dices } from 'lucide-react'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { SettingsCardDialogProps } from './card-types'

type AdvancedFields = Pick<
  EngineSettings,
  | 'rpcPort'
  | 'rpcSecret'
  | 'sqlite3Persistence'
  | 'sqlite3DbPath'
  | 'sqlite3HistoryLimit'
>

const DEFAULTS: AdvancedFields = {
  rpcPort: DEFAULT_ENGINE_SETTINGS.rpcPort,
  rpcSecret: DEFAULT_ENGINE_SETTINGS.rpcSecret,
  sqlite3Persistence: DEFAULT_ENGINE_SETTINGS.sqlite3Persistence,
  sqlite3DbPath: DEFAULT_ENGINE_SETTINGS.sqlite3DbPath,
  sqlite3HistoryLimit: DEFAULT_ENGINE_SETTINGS.sqlite3HistoryLimit,
}

export function AdvancedDialog({
  open,
  onClose,
  labelKey,
  descKey,
}: SettingsCardDialogProps) {
  const { t } = useTranslation()
  const form = useForm<AdvancedFields>({ defaultValues: DEFAULTS })

  // biome-ignore lint/correctness/useExhaustiveDependencies: form is stable
  useEffect(() => {
    let cancelled = false
    transport
      .invoke(Queries.GetSettings)
      .then((data) => {
        if (cancelled) return
        const all = data as AppSettings
        if (all?.engine) {
          form.reset({
            rpcPort: all.engine.rpcPort,
            rpcSecret: all.engine.rpcSecret,
            sqlite3Persistence: all.engine.sqlite3Persistence,
            sqlite3DbPath: all.engine.sqlite3DbPath,
            sqlite3HistoryLimit: all.engine.sqlite3HistoryLimit,
          })
        }
      })
      .catch(() => {
        /* keep defaults */
      })
    return () => {
      cancelled = true
    }
  }, [])

  const onSubmit = form.handleSubmit(async (values) => {
    const dirty = pickDirty(values, form.formState.dirtyFields)
    if (!dirty) {
      onClose()
      return
    }
    const patch = { engine: dirty }
    await transport.invoke(Commands.UpdateSettings, patch)
    onClose()
  })

  const persistenceOn = form.watch('sqlite3Persistence')

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
              <h3 className="text-sm font-semibold text-foreground">
                {t('settings.advanced.rpc.title')}
              </h3>

              <FormField
                control={form.control}
                name="rpcPort"
                render={({ field }) => (
                  <FormItem className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <FormLabel>{t('settings.advanced.rpc.port')}</FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.advanced.rpc.portDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Input
                        type="number"
                        min={1024}
                        max={65535}
                        className="w-30 h-8"
                        value={field.value}
                        onChange={(e) => {
                          const n = Number.parseInt(e.target.value, 10)
                          field.onChange(
                            Number.isFinite(n)
                              ? Math.min(65535, Math.max(1024, n))
                              : DEFAULT_ENGINE_SETTINGS.rpcPort
                          )
                        }}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="rpcSecret"
                render={({ field }) => (
                  <FormItem className="space-y-2">
                    <div className="space-y-1">
                      <FormLabel>{t('settings.advanced.rpc.secret')}</FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.advanced.rpc.secretDesc')}
                      </FormDescription>
                    </div>
                    <div className="flex gap-2">
                      <FormControl>
                        <PasswordInput
                          value={field.value}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          showPasswordLabel={t('settings.common.showSecret')}
                          hidePasswordLabel={t('settings.common.hideSecret')}
                          className="flex-1"
                        />
                      </FormControl>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={t('settings.common.generate')}
                        onClick={() => field.onChange(generateRpcSecret())}
                      >
                        <Dices className="h-3 w-3" />
                      </Button>
                    </div>
                  </FormItem>
                )}
              />

              <Separator className="my-4" />

              <h3 className="text-sm font-semibold text-foreground">
                {t('settings.advanced.persistence.title')}
              </h3>

              <FormField
                control={form.control}
                name="sqlite3Persistence"
                render={({ field }) => (
                  <FormItem className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <FormLabel>
                        {t('settings.advanced.persistence.enable')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.advanced.persistence.enableDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="sqlite3DbPath"
                render={({ field }) => (
                  <FormItem className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <FormLabel>
                        {t('settings.advanced.persistence.dbPath')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.advanced.persistence.dbPathDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Input
                        className="w-56 h-8"
                        placeholder={t(
                          'settings.advanced.persistence.dbPathPlaceholder'
                        )}
                        disabled={!persistenceOn}
                        value={field.value}
                        onChange={field.onChange}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="sqlite3HistoryLimit"
                render={({ field }) => (
                  <FormItem className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <FormLabel>
                        {t('settings.advanced.persistence.historyLimit')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.advanced.persistence.historyLimitDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Input
                        type="number"
                        min={-1}
                        className="w-30 h-8"
                        disabled={!persistenceOn}
                        value={field.value}
                        onChange={(e) => {
                          const parsed = Number.parseInt(e.target.value, 10)
                          field.onChange(
                            Number.isFinite(parsed) ? Math.max(-1, parsed) : -1
                          )
                        }}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
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
