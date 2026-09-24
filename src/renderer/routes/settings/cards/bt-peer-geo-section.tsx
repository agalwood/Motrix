import { SettingsFormRow } from '@renderer/components/settings-kit/settings-form-row'
import { SettingsSelectTrigger } from '@renderer/components/settings-kit/settings-select-trigger'
import { useSettingsForm } from '@renderer/components/settings-kit/use-settings-form'
import { Button } from '@renderer/components/ui/button'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormLabel,
} from '@renderer/components/ui/form'
import { Input } from '@renderer/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectValue,
} from '@renderer/components/ui/select'
import { Spinner } from '@renderer/components/ui/spinner'
import { Switch } from '@renderer/components/ui/switch'
import { useByteFormat } from '@renderer/hooks/use-byte-format'
import { useGeoIPStatus } from '@renderer/hooks/use-geoip-status'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  DEFAULT_GEOIP_SETTINGS,
  geoIpSettingsInputSchema,
} from '@shared/schemas/geoip-settings'
import type { GeoIPSettings, GeoIPSource } from '@shared/types/geoip'
import type { AppSettings } from '@shared/types/settings'
import {
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

const SAVE_DEBOUNCE_MS = 400

const SOURCES: ReadonlyArray<{ key: GeoIPSource; disabled?: boolean }> = [
  { key: 'loyalsoldier' },
  { key: 'p3terx' },
  { key: 'maxmind', disabled: true },
  { key: 'custom' },
]

function formatTimestamp(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export interface BtPeerGeoSectionHandle {
  flush: () => Promise<boolean>
}

export function BtPeerGeoSection({
  ref,
}: {
  ref?: Ref<BtPeerGeoSectionHandle>
}) {
  const { formatBytes } = useByteFormat()

  const { t } = useTranslation()
  const { status, progress, triggerUpdate } = useGeoIPStatus()
  const [updateError, setUpdateError] = useState<string | null>(null)
  const form = useSettingsForm<GeoIPSettings>(
    geoIpSettingsInputSchema,
    DEFAULT_GEOIP_SETTINGS
  )
  const sourceOptions = SOURCES.map(({ key, disabled }) => ({
    value: key,
    label: `${t(`settings.bittorrent.geoip.source.${key}`)}${
      disabled ? ` (${t('settings.bittorrent.geoip.maxmindUnsupported')})` : ''
    }`,
    disabled,
  }))

  const savedValues = useRef(DEFAULT_GEOIP_SETTINGS)
  const revision = useRef(0)
  const mounted = useRef(true)
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Initial fetch — settings are the source of truth for source/url/etc.;
  // `status` (from the hook) drives the live download/loaded indicators.
  useEffect(() => {
    let cancelled = false
    transport
      .invoke(Queries.GetSettings)
      .then((data) => {
        if (cancelled) return
        const all = data as AppSettings
        if (all?.geoip) {
          savedValues.current = all.geoip
          form.reset(all.geoip)
        }
      })
      .catch(() => {
        /* keep defaults */
      })
    return () => {
      cancelled = true
    }
  }, [form])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      revision.current += 1
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const persist = (expectedRevision: number, disableOnly = false) => {
    const pending = saveQueue.current.then(async () => {
      if (!mounted.current || revision.current !== expectedRevision)
        return false
      const valid = disableOnly
        ? await form.trigger('enabled')
        : await form.trigger()
      if (!valid || !mounted.current || revision.current !== expectedRevision)
        return false
      const values = form.getValues()
      const patch: Partial<GeoIPSettings> = disableOnly
        ? { enabled: false }
        : Object.fromEntries(
            (['enabled', 'source', 'customUrl', 'autoUpdate'] as const)
              .filter((key) => values[key] !== savedValues.current[key])
              .map((key) => [key, values[key]])
          )
      if (Object.keys(patch).length === 0) {
        form.clearErrors('root.save')
        return true
      }
      try {
        await transport.invoke(Commands.UpdateSettings, { geoip: patch })
        savedValues.current = { ...savedValues.current, ...patch }
        if (mounted.current) form.clearErrors('root.save')
        return true
      } catch {
        if (mounted.current)
          form.setError('root.save', {
            type: 'server',
            message: t('settings.validation.saveFailed'),
          })
        return false
      }
    })
    saveQueue.current = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  const saveField = <Key extends keyof GeoIPSettings>(
    key: Key,
    value: GeoIPSettings[Key],
    debounce = false
  ) => {
    const expectedRevision = ++revision.current
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (debounce) {
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null
        void persist(expectedRevision)
      }, SAVE_DEBOUNCE_MS)
    } else {
      void persist(expectedRevision, key === 'enabled' && value === false)
    }
  }

  const flush = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    return persist(++revision.current)
  }
  useImperativeHandle(ref, () => ({ flush }))

  const enabled = form.watch('enabled')
  const source = form.watch('source')
  const isDownloading = status?.isDownloading ?? false
  const handleUpdateNow = async () => {
    setUpdateError(null)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const expectedRevision = ++revision.current
    const saved = await persist(expectedRevision)
    if (!saved || !mounted.current || revision.current !== expectedRevision)
      return
    try {
      await triggerUpdate()
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : 'update failed')
    }
  }

  const lastUpdatedLabel = status?.lastUpdatedAt
    ? formatTimestamp(status.lastUpdatedAt)
    : t('settings.bittorrent.geoip.neverUpdated')

  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold text-foreground">
        {t('settings.bittorrent.geoip.title')}
      </h3>

      <Form {...form}>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => event.preventDefault()}
        >
          <FormField
            control={form.control}
            name="enabled"
            render={({ field }) => (
              <SettingsFormRow>
                <div className="space-y-1">
                  <FormLabel>{t('settings.bittorrent.geoip.enable')}</FormLabel>
                  <FormDescription className="text-xs">
                    {t('settings.bittorrent.geoip.enableDesc')}
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    onCheckedChange={(v) => {
                      const next = Boolean(v)
                      field.onChange(next)
                      saveField('enabled', next)
                    }}
                  />
                </FormControl>
              </SettingsFormRow>
            )}
          />

          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
              <span>
                {t('settings.bittorrent.geoip.lastUpdated')}: {lastUpdatedLabel}
              </span>
              <span>
                {status?.databaseVersion
                  ? `v${status.databaseVersion} · ${formatBytes(status.sizeBytes)}`
                  : t('settings.bittorrent.geoip.status.notDownloaded')}
              </span>
              {(status?.lastError || updateError) && (
                <span className="text-destructive" data-testid="geoip-error">
                  {updateError ?? status?.lastError}
                </span>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!enabled || isDownloading}
              onClick={handleUpdateNow}
            >
              {isDownloading ? (
                <>
                  <Spinner className="size-3" />
                  {progress && progress.percent >= 0
                    ? `${Math.round(progress.percent * 100)}%`
                    : t('settings.bittorrent.geoip.updating')}
                </>
              ) : (
                t('settings.bittorrent.geoip.updateNow')
              )}
            </Button>
          </div>

          <FormField
            control={form.control}
            name="source"
            render={({ field }) => (
              <SettingsFormRow>
                <div className="space-y-1">
                  <FormLabel>{t('settings.bittorrent.geoip.source')}</FormLabel>
                  <FormDescription className="text-xs">
                    {t('settings.bittorrent.geoip.sourceDesc')}
                  </FormDescription>
                </div>
                <FormControl>
                  <Select
                    items={sourceOptions}
                    value={field.value}
                    onValueChange={(value) => {
                      if (value === null) return
                      field.onChange(value)
                      saveField('source', value)
                    }}
                    disabled={!enabled}
                  >
                    <SettingsSelectTrigger className="min-w-56 max-w-80">
                      <SelectValue />
                    </SettingsSelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {sourceOptions.map(({ disabled, label, value }) => (
                          <SelectItem
                            key={value}
                            value={value}
                            disabled={disabled}
                          >
                            {label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </FormControl>
              </SettingsFormRow>
            )}
          />

          {(source === 'custom' || form.formState.errors.customUrl) && (
            <FormField
              control={form.control}
              name="customUrl"
              render={({ field }) => (
                <SettingsFormRow>
                  <div className="space-y-1">
                    <FormLabel>
                      {t('settings.bittorrent.geoip.customUrl')}
                    </FormLabel>
                  </div>
                  <FormControl>
                    <Input
                      className="w-72 h-8"
                      disabled={!enabled && !form.formState.errors.customUrl}
                      placeholder={t(
                        'settings.bittorrent.geoip.customUrlPlaceholder'
                      )}
                      {...field}
                      onChange={(e) => {
                        field.onChange(e)
                        saveField('customUrl', e.target.value, true)
                      }}
                    />
                  </FormControl>
                </SettingsFormRow>
              )}
            />
          )}

          <FormField
            control={form.control}
            name="autoUpdate"
            render={({ field }) => (
              <SettingsFormRow>
                <div className="space-y-1">
                  <FormLabel>
                    {t('settings.bittorrent.geoip.autoUpdate')}
                  </FormLabel>
                  <FormDescription className="text-xs">
                    {t('settings.bittorrent.geoip.autoUpdateDesc')}
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={field.value}
                    disabled={!enabled}
                    onCheckedChange={(v) => {
                      const next = Boolean(v)
                      field.onChange(next)
                      saveField('autoUpdate', next)
                    }}
                  />
                </FormControl>
              </SettingsFormRow>
            )}
          />
          {form.formState.errors.root?.save && (
            <p role="alert" className="text-xs text-destructive">
              {form.formState.errors.root.save.message}
            </p>
          )}
        </form>
      </Form>
    </section>
  )
}
