import { SettingsSelectTrigger } from '@renderer/components/settings-kit/settings-select-trigger'
import { Button } from '@renderer/components/ui/button'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
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
import { useGeoIPStatus } from '@renderer/hooks/use-geoip-status'
import { formatBytes } from '@renderer/lib/format'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import type { GeoIPSettings, GeoIPSource } from '@shared/types/geoip'
import type { AppSettings } from '@shared/types/settings'
import { useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

const SAVE_DEBOUNCE_MS = 400

const DEFAULT_GEOIP: GeoIPSettings = {
  enabled: false,
  source: 'loyalsoldier',
  customUrl: '',
  maxmindLicenseKey: '',
  autoUpdate: true,
  autoUpdateIntervalDays: 7,
  lastUpdatedAt: 0,
  databaseVersion: '',
}

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

export function BtPeerGeoSection() {
  const { t } = useTranslation()
  const { status, progress, triggerUpdate } = useGeoIPStatus()
  const [updateError, setUpdateError] = useState<string | null>(null)
  const form = useForm<GeoIPSettings>({ defaultValues: DEFAULT_GEOIP })
  const sourceOptions = SOURCES.map(({ key, disabled }) => ({
    value: key,
    label: `${t(`settings.bittorrent.geoip.source.${key}`)}${
      disabled ? ` (${t('settings.bittorrent.geoip.maxmindUnsupported')})` : ''
    }`,
    disabled,
  }))

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
        if (all?.geoip) form.reset(all.geoip)
      })
      .catch(() => {
        /* keep defaults */
      })
    return () => {
      cancelled = true
    }
  }, [form])

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const save = async (patch: Partial<GeoIPSettings>): Promise<void> => {
    await transport.invoke(Commands.UpdateSettings, { geoip: patch })
  }

  const debouncedSave = (patch: Partial<GeoIPSettings>) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      save(patch).catch(() => {
        /* surfaced via status events */
      })
      debounceRef.current = null
    }, SAVE_DEBOUNCE_MS)
  }

  const saveField = <K extends keyof GeoIPSettings>(
    key: K,
    value: GeoIPSettings[K],
    debounce = false
  ) => {
    const patch = { [key]: value } as Partial<GeoIPSettings>
    if (debounce) debouncedSave(patch)
    else save(patch).catch(() => undefined)
  }

  const enabled = form.watch('enabled')
  const source = form.watch('source')
  const isDownloading = status?.isDownloading ?? false
  const handleUpdateNow = async () => {
    setUpdateError(null)
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
        <form className="space-y-4">
          <FormField
            control={form.control}
            name="enabled"
            render={({ field }) => (
              <FormItem className="flex items-start justify-between gap-4">
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
              </FormItem>
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
              <FormItem className="flex items-start justify-between gap-4">
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
              </FormItem>
            )}
          />

          {source === 'custom' && (
            <FormField
              control={form.control}
              name="customUrl"
              render={({ field }) => (
                <FormItem className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <FormLabel>
                      {t('settings.bittorrent.geoip.customUrl')}
                    </FormLabel>
                  </div>
                  <FormControl>
                    <Input
                      className="w-72 h-8"
                      disabled={!enabled}
                      placeholder={t(
                        'settings.bittorrent.geoip.customUrlPlaceholder'
                      )}
                      value={field.value}
                      onChange={(e) => {
                        field.onChange(e)
                        saveField('customUrl', e.target.value, true)
                      }}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
          )}

          <FormField
            control={form.control}
            name="autoUpdate"
            render={({ field }) => (
              <FormItem className="flex items-start justify-between gap-4">
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
              </FormItem>
            )}
          />
        </form>
      </Form>
    </section>
  )
}
