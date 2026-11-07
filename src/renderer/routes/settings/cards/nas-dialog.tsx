import { CopyButton } from '@renderer/components/desktop-kit/copy-button'
import {
  useSettingsForm,
  useSettingsSubmit,
} from '@renderer/components/settings-kit/use-settings-form'
import { SettingsLoadStatus } from '@renderer/components/settings-kit/use-settings-load'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
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
  FormMessage,
} from '@renderer/components/ui/form'
import { Input } from '@renderer/components/ui/input'
import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaViewport,
  ScrollBar,
} from '@renderer/components/ui/scroll-area'
import { Separator } from '@renderer/components/ui/separator'
import { Switch } from '@renderer/components/ui/switch'
import { Textarea } from '@renderer/components/ui/textarea'
import { useOperatorSession } from '@renderer/lib/operator-auth'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  type NasPackageSettings,
  type NasSettingsView,
  nasPackageSettingsSchema,
  nasSettingsResultSchema,
  synologyConnectionUrls,
} from '@shared/schemas/nas-settings'
import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { SettingsCardDialogProps } from './card-types'

const DEFAULTS: NasPackageSettings = {
  roots: [''],
  clientPort: 16802,
  extensionUrl: '',
  operatorUrl: '',
  allowHttp: false,
}

export function NasDialog(props: SettingsCardDialogProps) {
  const { t } = useTranslation()
  return (
    <NasSettingsBoundary
      fallback={
        <Dialog
          open={props.open}
          onOpenChange={(open) => {
            if (!open) props.onClose()
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t(props.labelKey)}</DialogTitle>
              <DialogDescription>
                {t('settings.validation.loadFailed')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" size="sm" onClick={props.onClose}>
                {t('common.close')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      }
    >
      <NasDialogForm {...props} />
    </NasSettingsBoundary>
  )
}

class NasSettingsBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function NasDialogForm({ open, onClose, labelKey }: SettingsCardDialogProps) {
  const { t } = useTranslation()
  const foldersOnly = useOperatorSession((session) =>
    Boolean(session.status?.nasUnavailableDownloadRoots?.length)
  )
  const username = useOperatorSession(
    (session) => session.status?.username ?? ''
  )
  const form = useSettingsForm(nasPackageSettingsSchema, DEFAULTS)
  const [view, setView] = useState<NasSettingsView | null>(null)
  const [load, setLoad] = useState({ ready: false, error: false })
  const [error, setError] = useState<string | null>(null)
  const [rootsText, setRootsText] = useState('')
  const generation = useRef(0)
  const currentView = useRef<NasSettingsView | null>(null)
  const saving = useRef(false)
  const dirty = useRef(false)
  dirty.current = form.formState.isDirty
  const { reset } = form
  const refresh = useCallback(
    async (preserveDraft = false) => {
      if (saving.current) return
      const preserve = preserveDraft && dirty.current
      const current = ++generation.current
      if (!preserve) setLoad({ ready: false, error: false })
      try {
        const result = nasSettingsResultSchema.parse(
          await transport.invoke(Queries.GetNasSettings)
        )
        if (!result.ok) throw new Error('NAS configuration unavailable')
        if (current !== generation.current) return
        if (preserve) {
          setError(
            result.value.revision === currentView.current?.revision
              ? null
              : 'conflict'
          )
          return
        }
        currentView.current = result.value
        setView(result.value)
        setRootsText(result.value.settings.roots.join('\n'))
        reset({
          ...result.value.settings,
          operatorUrl: foldersOnly
            ? result.value.settings.operatorUrl
            : result.value.settings.operatorUrl ||
              synologyConnectionUrls(location.origin).operatorUrl,
        })
        setError(null)
        setLoad({ ready: true, error: false })
      } catch {
        if (current === generation.current) {
          if (preserve) setError('unavailable')
          else setLoad({ ready: false, error: true })
        }
      }
    },
    [reset, foldersOnly]
  )
  useEffect(() => {
    const unsubscribe = transport.onConnectionChange?.(({ state }) => {
      if (state !== 'connected') return
      void refresh(true)
    })
    void refresh()
    return () => {
      generation.current++
      unsubscribe?.()
    }
  }, [refresh])
  const extensionUrl = form.watch('extensionUrl')
  const busy = form.formState.isSubmitting
  const applyCurrentAddress = () => {
    const urls = synologyConnectionUrls(location.origin)
    form.setValue('operatorUrl', urls.operatorUrl, { shouldDirty: true })
    if (form.getValues('extensionUrl'))
      form.setValue('extensionUrl', urls.extensionUrl, { shouldDirty: true })
  }
  const submit = useSettingsSubmit(form, async (settings) => {
    if (!view || !load.ready) return
    const current = ++generation.current
    saving.current = true
    setError(null)
    // Package grants are host-owned configuration, not generic app preferences.
    try {
      const result = nasSettingsResultSchema.parse(
        await transport.invoke(Commands.SaveNasSettings, {
          revision: view.revision,
          settings,
        })
      )
      if (current !== generation.current) return
      if (!result.ok) {
        setError(result.error.code)
        return
      }
      currentView.current = result.value
      setView(result.value)
      form.reset(result.value.settings)
      setRootsText(result.value.settings.roots.join('\n'))
    } finally {
      saving.current = false
    }
  })
  const activeOperator =
    view?.active.operatorUrl ||
    synologyConnectionUrls(location.origin).operatorUrl
  let cliAddress = `${location.origin}/motrix/client`
  try {
    cliAddress = `${new URL(activeOperator).origin}/motrix/client`
  } catch {
    /* The form can repair an invalid legacy URL. */
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(value, details) => {
        if (!value) {
          if (busy) details.cancel()
          else onClose()
        }
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-[700px]"
        initialFocus={false}
      >
        <DialogHeader className="shrink-0 px-6 pt-6">
          <DialogTitle>{t(labelKey)}</DialogTitle>
          <DialogDescription>{t('settings.nas.description')}</DialogDescription>
        </DialogHeader>
        <ScrollArea className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ScrollAreaViewport
            tabIndex={-1}
            className="min-h-0 flex-1 overscroll-contain"
          >
            <ScrollAreaContent
              className="space-y-4 px-6 py-4"
              style={{ minWidth: '100%' }}
            >
              <SettingsLoadStatus {...load} retry={refresh} />
              <p className="text-xs text-muted-foreground">
                {t('settings.nas.account', { username })}
              </p>
              {view?.restartRequired && (
                <Alert>
                  <AlertDescription>
                    {t('settings.nas.restartRequired')}
                  </AlertDescription>
                </Alert>
              )}
              <Form {...form}>
                <form noValidate onSubmit={submit}>
                  <fieldset
                    className="min-w-0 space-y-5"
                    disabled={!load.ready || busy}
                    inert={!load.ready || busy}
                  >
                    <section
                      className="space-y-3"
                      aria-label={t('settings.nas.roots')}
                    >
                      {!foldersOnly && (
                        <h3 className="text-sm font-semibold">
                          {t('settings.nas.roots')}
                        </h3>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {t('settings.nas.rootsHint')}
                      </p>
                      <FormField
                        control={form.control}
                        name="roots"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel className="sr-only">
                              {t('settings.nas.roots')}
                            </FormLabel>
                            <FormControl>
                              <Textarea
                                ref={field.ref}
                                name={field.name}
                                onBlur={field.onBlur}
                                rows={3}
                                spellCheck={false}
                                value={rootsText}
                                placeholder="/volume1/motrix"
                                onChange={(event) => {
                                  setRootsText(event.target.value)
                                  field.onChange(
                                    event.target.value
                                      .split(/\r?\n/)
                                      .map((value) =>
                                        value.trim().replace(/\/+$/, '')
                                      )
                                      .filter(Boolean)
                                  )
                                }}
                              />
                            </FormControl>
                            <FormMessage className="text-xs" />
                          </FormItem>
                        )}
                      />
                    </section>
                    {!foldersOnly && (
                      <>
                        <Separator />
                        <FormField
                          control={form.control}
                          name="extensionUrl"
                          render={({ field }) => (
                            <FormItem className="flex items-start justify-between gap-4">
                              <div className="space-y-1">
                                <FormLabel>
                                  {t('settings.nas.extensionEnabled')}
                                </FormLabel>
                                <FormDescription className="text-xs">
                                  {t('settings.nas.extensionHint')}
                                </FormDescription>
                              </div>
                              <FormControl>
                                <Switch
                                  checked={Boolean(field.value)}
                                  onCheckedChange={(enabled) => {
                                    if (!enabled) {
                                      field.onChange('')
                                      return
                                    }
                                    let urls: ReturnType<
                                      typeof synologyConnectionUrls
                                    >
                                    try {
                                      const origin = new URL(
                                        form.getValues('operatorUrl') ||
                                          location.origin
                                      ).origin
                                      urls = synologyConnectionUrls(origin)
                                    } catch {
                                      form.setError('operatorUrl', {
                                        message: t(
                                          'settings.nas.errors.invalid'
                                        ),
                                      })
                                      return
                                    }
                                    if (!form.getValues('operatorUrl'))
                                      form.setValue(
                                        'operatorUrl',
                                        urls.operatorUrl,
                                        { shouldDirty: true }
                                      )
                                    field.onChange(
                                      enabled ? urls.extensionUrl : ''
                                    )
                                  }}
                                />
                              </FormControl>
                            </FormItem>
                          )}
                        />
                        <FormField
                          control={form.control}
                          name="operatorUrl"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>
                                {t('settings.nas.webAddress')}
                              </FormLabel>
                              <FormControl>
                                <Input {...field} spellCheck={false} />
                              </FormControl>
                              <FormDescription className="text-xs">
                                {t('settings.nas.webAddressHint')}
                              </FormDescription>
                              <FormMessage className="text-xs" />
                            </FormItem>
                          )}
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={applyCurrentAddress}
                        >
                          {t('settings.nas.useCurrentAddress')}
                        </Button>
                        {extensionUrl && (
                          <FormField
                            control={form.control}
                            name="extensionUrl"
                            render={({ field }) => (
                              <FormItem>
                                <FormLabel>
                                  {t('settings.nas.extensionAddress')}
                                </FormLabel>
                                <FormControl>
                                  <Input {...field} spellCheck={false} />
                                </FormControl>
                                <FormMessage className="text-xs" />
                              </FormItem>
                            )}
                          />
                        )}
                        <FormField
                          control={form.control}
                          name="allowHttp"
                          render={({ field }) => (
                            <FormItem className="flex items-start justify-between gap-4">
                              <div className="space-y-1">
                                <FormLabel>
                                  {t('settings.nas.allowHttp')}
                                </FormLabel>
                                <FormDescription className="text-xs">
                                  {t('settings.nas.allowHttpHint')}
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
                          name="clientPort"
                          render={({ field }) => (
                            <FormItem>
                              <FormLabel>
                                {t('settings.nas.clientPort')}
                              </FormLabel>
                              <FormControl>
                                <Input
                                  type="number"
                                  min={1024}
                                  max={65535}
                                  {...field}
                                  onChange={(event) =>
                                    field.onChange(Number(event.target.value))
                                  }
                                />
                              </FormControl>
                              <FormDescription className="text-xs">
                                {t('settings.nas.clientPortHint')}
                              </FormDescription>
                              <FormMessage className="text-xs" />
                            </FormItem>
                          )}
                        />
                      </>
                    )}
                  </fieldset>
                </form>
              </Form>
              {view && !foldersOnly && (
                <section
                  className="space-y-3 border-t pt-4"
                  aria-label={t('settings.nas.activeConnections')}
                >
                  <h3 className="text-sm font-semibold">
                    {t('settings.nas.activeConnections')}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {t('settings.nas.sessionHint')}
                  </p>
                  <ConnectionAddress
                    label={t('settings.nas.cliAddress')}
                    value={cliAddress}
                  />
                  {view.active.extensionUrl && (
                    <ConnectionAddress
                      label={t('settings.nas.extensionAddress')}
                      value={view.active.extensionUrl}
                    />
                  )}
                </section>
              )}
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {t(`settings.nas.errors.${error}`)}
                  </AlertDescription>
                  {error === 'conflict' && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void refresh()}
                    >
                      {t('common.retry')}
                    </Button>
                  )}
                </Alert>
              )}
              {form.formState.errors.root?.save && (
                <p role="alert" className="text-xs text-destructive">
                  {form.formState.errors.root.save.message}
                </p>
              )}
            </ScrollAreaContent>
          </ScrollAreaViewport>
          <ScrollBar />
        </ScrollArea>
        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            {t('common.close')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!load.ready || busy || error === 'conflict'}
            onClick={submit}
          >
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ConnectionAddress({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">{label}</p>
      <div className="flex gap-2">
        <Input aria-label={label} value={value} readOnly spellCheck={false} />
        <CopyButton content={value} size="sm" variant="outline">
          {t('settings.nas.copy')}
        </CopyButton>
      </div>
    </div>
  )
}
