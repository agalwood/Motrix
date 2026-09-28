import { SettingsFormRow } from '@renderer/components/settings-kit/settings-form-row'
import { SettingsSelectTrigger } from '@renderer/components/settings-kit/settings-select-trigger'
import { Button } from '@renderer/components/ui/button'
import {
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
import type { GeoIPSource } from '@shared/types/geoip'
import { useEffect, useRef, useState } from 'react'
import type { UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { BtFields } from './bit-torrent-dialog'

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

export function BtPeerGeoSection({
  form,
  ready,
}: {
  form: UseFormReturn<BtFields>
  ready: boolean
}) {
  const { formatBytes } = useByteFormat()
  const { t } = useTranslation()
  const { status, progress, triggerUpdate } = useGeoIPStatus()
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [updating, setUpdating] = useState(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const sourceOptions = SOURCES.map(({ key, disabled }) => ({
    value: key,
    label: `${t(`settings.bittorrent.geoip.source.${key}`)}${disabled ? ` (${t('settings.bittorrent.geoip.maxmindUnsupported')})` : ''}`,
    disabled,
  }))
  const enabled = form.watch('geoip.enabled')
  const source = form.watch('geoip.source')
  const pendingChanges = Boolean(form.formState.dirtyFields.geoip)
  const isDownloading = updating || (status?.isDownloading ?? false)
  const handleUpdateNow = async () => {
    if (
      !ready ||
      pendingChanges ||
      !enabled ||
      isDownloading ||
      form.formState.isSubmitting
    )
      return
    setUpdateError(null)
    setUpdating(true)
    try {
      await triggerUpdate()
    } catch {
      if (mounted.current)
        setUpdateError(t('settings.bittorrent.geoip.updateFailed'))
    } finally {
      if (mounted.current) setUpdating(false)
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

      <div className="space-y-4">
        <FormField
          control={form.control}
          name="geoip.enabled"
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
            disabled={
              !ready ||
              !enabled ||
              isDownloading ||
              pendingChanges ||
              form.formState.isSubmitting
            }
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

        {pendingChanges && (
          <p className="text-xs text-muted-foreground">
            {t('settings.bittorrent.geoip.saveBeforeUpdate')}
          </p>
        )}

        <FormField
          control={form.control}
          name="geoip.source"
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

        {(source === 'custom' || form.formState.errors.geoip?.customUrl) && (
          <FormField
            control={form.control}
            name="geoip.customUrl"
            render={({ field }) => (
              <SettingsFormRow>
                <div className="space-y-1">
                  <FormLabel>
                    {t('settings.bittorrent.geoip.customUrl')}
                  </FormLabel>
                  <FormDescription className="text-xs">
                    {t('settings.bittorrent.geoip.customUrlDesc')}
                  </FormDescription>
                </div>
                <FormControl>
                  <Input
                    className="w-72 h-8"
                    disabled={
                      !enabled && !form.formState.errors.geoip?.customUrl
                    }
                    placeholder={t(
                      'settings.bittorrent.geoip.customUrlPlaceholder'
                    )}
                    {...field}
                    onChange={(e) => {
                      field.onChange(e)
                    }}
                  />
                </FormControl>
              </SettingsFormRow>
            )}
          />
        )}

        <FormField
          control={form.control}
          name="geoip.autoUpdate"
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
                  }}
                />
              </FormControl>
            </SettingsFormRow>
          )}
        />
      </div>
    </section>
  )
}
