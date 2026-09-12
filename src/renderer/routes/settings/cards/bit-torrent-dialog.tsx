import { SettingsFormRow } from '@renderer/components/settings-kit/settings-form-row'
// src/renderer/routes/settings/cards/bit-torrent-dialog.tsx

import { PresetChips } from '@renderer/components/settings-kit/preset-chips'
import {
  useSettingsForm,
  useSettingsSubmit,
} from '@renderer/components/settings-kit/use-settings-form'
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
import { Separator } from '@renderer/components/ui/separator'
import { Switch } from '@renderer/components/ui/switch'
import { pickDirty } from '@renderer/lib/form-utils'
import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { DEFAULT_APP_SETTINGS, DEFAULT_ENGINE_SETTINGS } from '@shared/schemas'
import {
  MAGNET_FILE_SELECTION_TIMEOUT_MAX_SECONDS,
  MAGNET_FILE_SELECTION_TIMEOUT_MIN_SECONDS,
} from '@shared/schemas/app-settings'
import { DEFAULT_TRACKER_SETTINGS } from '@shared/schemas/tracker-settings'
import type {
  AppSettings,
  EngineSettings,
  MotrixAppSettings,
  TrackerSettings,
} from '@shared/types/settings'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BtPeerGeoSection,
  type BtPeerGeoSectionHandle,
} from './bt-peer-geo-section'
import type { SettingsCardDialogProps } from './card-types'
import { bitTorrentFormSchema } from './settings-form-schemas'

interface BtFields {
  engine: Pick<
    EngineSettings,
    | 'listenPort'
    | 'dhtListenPort'
    | 'dhtEnabled'
    | 'btMaxPeers'
    | 'btEnableLpd'
    | 'seedRatio'
    | 'seedTime'
  >
  app: Pick<
    MotrixAppSettings,
    | 'magnetFileSelection'
    | 'magnetFileSelectionAutoDownload'
    | 'magnetFileSelectionTimeoutSeconds'
  >
  tracker: Omit<
    TrackerSettings,
    'sources' | 'sourcesEnabled' | 'blacklistEnabled' | 'blacklistSources'
  >
}

const DEFAULTS: BtFields = {
  engine: {
    listenPort: DEFAULT_ENGINE_SETTINGS.listenPort,
    dhtListenPort: DEFAULT_ENGINE_SETTINGS.dhtListenPort,
    dhtEnabled: DEFAULT_ENGINE_SETTINGS.dhtEnabled,
    btMaxPeers: DEFAULT_ENGINE_SETTINGS.btMaxPeers,
    btEnableLpd: DEFAULT_ENGINE_SETTINGS.btEnableLpd,
    seedRatio: DEFAULT_ENGINE_SETTINGS.seedRatio,
    seedTime: DEFAULT_ENGINE_SETTINGS.seedTime,
  },
  app: {
    magnetFileSelection: DEFAULT_APP_SETTINGS.magnetFileSelection,
    magnetFileSelectionAutoDownload:
      DEFAULT_APP_SETTINGS.magnetFileSelectionAutoDownload,
    magnetFileSelectionTimeoutSeconds:
      DEFAULT_APP_SETTINGS.magnetFileSelectionTimeoutSeconds,
  },
  tracker: {
    autoSync: DEFAULT_TRACKER_SETTINGS.autoSync,
    syncIntervalHours: DEFAULT_TRACKER_SETTINGS.syncIntervalHours,
    probeEnabled: DEFAULT_TRACKER_SETTINGS.probeEnabled,
    probeTimeoutMs: DEFAULT_TRACKER_SETTINGS.probeTimeoutMs,
    healthyThresholdMs: DEFAULT_TRACKER_SETTINGS.healthyThresholdMs,
    minSuccessRate: DEFAULT_TRACKER_SETTINGS.minSuccessRate,
    maxTrackerCount: DEFAULT_TRACKER_SETTINGS.maxTrackerCount,
  },
}

export function BitTorrentDialog({
  open,
  onClose,
  labelKey,
  descKey,
}: SettingsCardDialogProps) {
  const { t } = useTranslation()
  const form = useSettingsForm<BtFields>(bitTorrentFormSchema, DEFAULTS)
  const fileSelectionEnabled = form.watch('app.magnetFileSelection')
  const autoDownloadEnabled = form.watch('app.magnetFileSelectionAutoDownload')

  // biome-ignore lint/correctness/useExhaustiveDependencies: form is stable
  useEffect(() => {
    let cancelled = false
    transport
      .invoke(Queries.GetSettings)
      .then((data) => {
        if (cancelled) return
        const all = data as AppSettings
        if (all) {
          form.reset({
            engine: {
              listenPort: all.engine.listenPort,
              dhtListenPort: all.engine.dhtListenPort,
              dhtEnabled: all.engine.dhtEnabled,
              btMaxPeers: all.engine.btMaxPeers,
              btEnableLpd: all.engine.btEnableLpd,
              seedRatio: all.engine.seedRatio,
              seedTime: all.engine.seedTime,
            },
            app: {
              magnetFileSelection: all.app.magnetFileSelection,
              magnetFileSelectionAutoDownload:
                all.app.magnetFileSelectionAutoDownload,
              magnetFileSelectionTimeoutSeconds:
                all.app.magnetFileSelectionTimeoutSeconds,
            },
            tracker: {
              autoSync: all.tracker.autoSync,
              syncIntervalHours: all.tracker.syncIntervalHours,
              probeEnabled: all.tracker.probeEnabled,
              probeTimeoutMs: all.tracker.probeTimeoutMs,
              healthyThresholdMs: all.tracker.healthyThresholdMs,
              minSuccessRate: all.tracker.minSuccessRate,
              maxTrackerCount: all.tracker.maxTrackerCount,
            },
          })
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const geoipRef = useRef<BtPeerGeoSectionHandle>(null)
  const onSubmit = useSettingsSubmit(form, async (values) => {
    if (!(await geoipRef.current?.flush())) return
    // biome-ignore lint/suspicious/noExplicitAny: dirtyFields array items don't fit DirtyTree; cast is safe
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
            <form className="space-y-4" noValidate onSubmit={onSubmit}>
              {/* Listen */}
              <h3 className="text-sm font-semibold text-foreground">
                {t('settings.bittorrent.listen.title')}
              </h3>
              <FormField
                control={form.control}
                name="engine.listenPort"
                render={({ field }) => (
                  <SettingsFormRow>
                    <div className="space-y-1">
                      <FormLabel>
                        {t('settings.bittorrent.listen.listenPort')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.bittorrent.listen.listenPortDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Input
                        {...field}
                        type="number"
                        min={1024}
                        max={65535}
                        className="w-30 h-8"
                        value={Number.isFinite(field.value) ? field.value : ''}
                        onChange={(event) =>
                          field.onChange(event.target.valueAsNumber)
                        }
                      />
                    </FormControl>
                  </SettingsFormRow>
                )}
              />
              <FormField
                control={form.control}
                name="engine.dhtListenPort"
                render={({ field }) => (
                  <SettingsFormRow>
                    <div className="space-y-1">
                      <FormLabel>
                        {t('settings.bittorrent.listen.dhtListenPort')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.bittorrent.listen.dhtListenPortDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Input
                        {...field}
                        type="number"
                        min={1024}
                        max={65535}
                        className="w-30 h-8"
                        value={Number.isFinite(field.value) ? field.value : ''}
                        onChange={(event) =>
                          field.onChange(event.target.valueAsNumber)
                        }
                      />
                    </FormControl>
                  </SettingsFormRow>
                )}
              />
              <FormField
                control={form.control}
                name="engine.dhtEnabled"
                render={({ field }) => (
                  <SettingsFormRow>
                    <div className="space-y-1">
                      <FormLabel>
                        {t('settings.bittorrent.listen.dhtEnabled')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.bittorrent.listen.dhtEnabledDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </SettingsFormRow>
                )}
              />

              <Separator className="my-4" />

              {/* Peers */}
              <h3 className="text-sm font-semibold text-foreground">
                {t('settings.bittorrent.peers.title')}
              </h3>
              <FormField
                control={form.control}
                name="engine.btMaxPeers"
                render={({ field }) => (
                  <SettingsFormRow>
                    <div className="space-y-1">
                      <FormLabel>
                        {t('settings.bittorrent.peers.btMaxPeers')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.bittorrent.peers.btMaxPeersDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Input
                        {...field}
                        type="number"
                        min={1}
                        max={1000}
                        className="w-30 h-8"
                        value={Number.isFinite(field.value) ? field.value : ''}
                        onChange={(event) =>
                          field.onChange(event.target.valueAsNumber)
                        }
                      />
                    </FormControl>
                  </SettingsFormRow>
                )}
              />
              <FormField
                control={form.control}
                name="engine.btEnableLpd"
                render={({ field }) => (
                  <SettingsFormRow>
                    <div className="space-y-1">
                      <FormLabel>
                        {t('settings.bittorrent.peers.btEnableLpd')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.bittorrent.peers.btEnableLpdDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </SettingsFormRow>
                )}
              />
              <FormField
                control={form.control}
                name="app.magnetFileSelection"
                render={({ field }) => (
                  <SettingsFormRow>
                    <div className="space-y-1">
                      <FormLabel>
                        {t('settings.bittorrent.peers.magnetFileSelection')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.bittorrent.peers.magnetFileSelectionDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </SettingsFormRow>
                )}
              />

              <FormField
                control={form.control}
                name="app.magnetFileSelectionAutoDownload"
                render={({ field }) => (
                  <SettingsFormRow>
                    <div className="space-y-1">
                      <FormLabel>
                        {t(
                          'settings.bittorrent.peers.magnetFileSelectionAutoDownload'
                        )}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t(
                          'settings.bittorrent.peers.magnetFileSelectionAutoDownloadDesc'
                        )}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        disabled={!fileSelectionEnabled}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </SettingsFormRow>
                )}
              />
              {(autoDownloadEnabled ||
                form.formState.errors.app
                  ?.magnetFileSelectionTimeoutSeconds) && (
                <FormField
                  control={form.control}
                  name="app.magnetFileSelectionTimeoutSeconds"
                  render={({ field }) => (
                    <FormItem className="flex items-start justify-between gap-4">
                      <div className="space-y-1">
                        <FormLabel>
                          {t(
                            'settings.bittorrent.peers.magnetFileSelectionTimeoutSeconds'
                          )}
                        </FormLabel>
                        <FormDescription className="text-xs">
                          {t(
                            'settings.bittorrent.peers.magnetFileSelectionTimeoutSecondsDesc'
                          )}
                        </FormDescription>
                        <FormMessage />
                      </div>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          min={MAGNET_FILE_SELECTION_TIMEOUT_MIN_SECONDS}
                          max={MAGNET_FILE_SELECTION_TIMEOUT_MAX_SECONDS}
                          step={1}
                          className="w-30 h-8"
                          disabled={
                            !fileSelectionEnabled &&
                            !form.formState.errors.app
                              ?.magnetFileSelectionTimeoutSeconds
                          }
                          value={
                            Number.isFinite(field.value) ? field.value : ''
                          }
                          onChange={(event) =>
                            field.onChange(event.target.valueAsNumber)
                          }
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              )}

              <Separator className="my-4" />

              {/* Seeding */}
              <h3 className="text-sm font-semibold text-foreground">
                {t('settings.bittorrent.seeding.title')}
              </h3>
              <FormField
                control={form.control}
                name="engine.seedRatio"
                render={({ field }) => (
                  <SettingsFormRow>
                    <div className="space-y-1">
                      <FormLabel>
                        {t('settings.bittorrent.seeding.seedRatio')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.bittorrent.seeding.seedRatioDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Input
                        {...field}
                        type="number"
                        min={0}
                        max={100}
                        step={0.1}
                        className="w-30 h-8"
                        value={Number.isFinite(field.value) ? field.value : ''}
                        onChange={(event) =>
                          field.onChange(event.target.valueAsNumber)
                        }
                      />
                    </FormControl>
                  </SettingsFormRow>
                )}
              />
              <FormField
                control={form.control}
                name="engine.seedTime"
                render={({ field }) => (
                  <SettingsFormRow>
                    <div className="space-y-1">
                      <FormLabel>
                        {t('settings.bittorrent.seeding.seedTime')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.bittorrent.seeding.seedTimeDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Input
                        {...field}
                        type="number"
                        min={0}
                        max={525600}
                        className="w-30 h-8"
                        value={Number.isFinite(field.value) ? field.value : ''}
                        onChange={(event) =>
                          field.onChange(event.target.valueAsNumber)
                        }
                      />
                    </FormControl>
                  </SettingsFormRow>
                )}
              />

              <Separator className="my-4" />

              {/* Trackers (config) */}
              <h3 className="text-sm font-semibold text-foreground">
                {t('settings.bittorrent.trackers.title')}
              </h3>
              <p className="text-xs text-muted-foreground">
                {t('settings.bittorrent.trackers.manageSourcesHint')}
              </p>

              <FormField
                control={form.control}
                name="tracker.autoSync"
                render={({ field }) => (
                  <SettingsFormRow>
                    <div className="space-y-1">
                      <FormLabel>
                        {t('settings.bittorrent.trackers.autoSync')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.bittorrent.trackers.autoSyncDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </SettingsFormRow>
                )}
              />

              <FormField
                control={form.control}
                name="tracker.syncIntervalHours"
                render={({ field }) => (
                  <FormItem className="space-y-2">
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-1">
                        <FormLabel>
                          {t('settings.bittorrent.trackers.syncInterval')}
                        </FormLabel>
                        <FormDescription className="text-xs">
                          {t('settings.bittorrent.trackers.syncIntervalDesc')}
                        </FormDescription>
                      </div>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          min={1}
                          max={168}
                          className="w-30 h-8"
                          value={
                            Number.isFinite(field.value) ? field.value : ''
                          }
                          onChange={(event) =>
                            field.onChange(event.target.valueAsNumber)
                          }
                        />
                      </FormControl>
                    </div>
                    <PresetChips
                      name="tracker.syncIntervalHours"
                      options={[
                        { label: '6h', value: 6 },
                        { label: '12h', value: 12 },
                        { label: '24h', value: 24 },
                      ]}
                    />
                    <FormMessage className="basis-full text-xs" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="tracker.probeEnabled"
                render={({ field }) => (
                  <SettingsFormRow>
                    <div className="space-y-1">
                      <FormLabel>
                        {t('settings.bittorrent.trackers.enableProbe')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.bittorrent.trackers.enableProbeDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                  </SettingsFormRow>
                )}
              />

              <FormField
                control={form.control}
                name="tracker.probeTimeoutMs"
                render={({ field }) => (
                  <FormItem className="space-y-2">
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-1">
                        <FormLabel>
                          {t('settings.bittorrent.trackers.probeTimeout')}
                        </FormLabel>
                        <FormDescription className="text-xs">
                          {t('settings.bittorrent.trackers.probeTimeoutDesc')}
                        </FormDescription>
                      </div>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          min={1000}
                          max={30000}
                          step={500}
                          className="w-30 h-8"
                          value={
                            Number.isFinite(field.value) ? field.value : ''
                          }
                          onChange={(event) =>
                            field.onChange(event.target.valueAsNumber)
                          }
                        />
                      </FormControl>
                    </div>
                    <PresetChips
                      name="tracker.probeTimeoutMs"
                      options={[
                        { label: '3s', value: 3000 },
                        { label: '5s', value: 5000 },
                        { label: '10s', value: 10000 },
                      ]}
                    />
                    <FormMessage className="basis-full text-xs" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="tracker.healthyThresholdMs"
                render={({ field }) => (
                  <FormItem className="space-y-2">
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-1">
                        <FormLabel>
                          {t('settings.bittorrent.trackers.healthyThreshold')}
                        </FormLabel>
                        <FormDescription className="text-xs">
                          {t(
                            'settings.bittorrent.trackers.healthyThresholdDesc'
                          )}
                        </FormDescription>
                      </div>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          min={500}
                          max={10000}
                          step={100}
                          className="w-30 h-8"
                          value={
                            Number.isFinite(field.value) ? field.value : ''
                          }
                          onChange={(event) =>
                            field.onChange(event.target.valueAsNumber)
                          }
                        />
                      </FormControl>
                    </div>
                    <PresetChips
                      name="tracker.healthyThresholdMs"
                      options={[
                        { label: '1s', value: 1000 },
                        { label: '2s', value: 2000 },
                        { label: '5s', value: 5000 },
                      ]}
                    />
                    <FormMessage className="basis-full text-xs" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="tracker.minSuccessRate"
                render={({ field }) => (
                  <SettingsFormRow>
                    <div className="space-y-1">
                      <FormLabel>
                        {t('settings.bittorrent.trackers.minSuccessRate')}
                      </FormLabel>
                      <FormDescription className="text-xs">
                        {t('settings.bittorrent.trackers.minSuccessRateDesc')}
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Input
                        {...field}
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        className="w-30 h-8"
                        value={Number.isFinite(field.value) ? field.value : ''}
                        onChange={(event) =>
                          field.onChange(event.target.valueAsNumber)
                        }
                      />
                    </FormControl>
                  </SettingsFormRow>
                )}
              />

              <FormField
                control={form.control}
                name="tracker.maxTrackerCount"
                render={({ field }) => (
                  <FormItem className="space-y-2">
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-1">
                        <FormLabel>
                          {t('settings.bittorrent.trackers.maxTrackerCount')}
                        </FormLabel>
                        <FormDescription className="text-xs">
                          {t(
                            'settings.bittorrent.trackers.maxTrackerCountDesc'
                          )}
                        </FormDescription>
                      </div>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          min={5}
                          max={200}
                          className="w-30 h-8"
                          value={
                            Number.isFinite(field.value) ? field.value : ''
                          }
                          onChange={(event) =>
                            field.onChange(event.target.valueAsNumber)
                          }
                        />
                      </FormControl>
                    </div>
                    <PresetChips
                      name="tracker.maxTrackerCount"
                      options={[
                        { label: '20', value: 20 },
                        { label: '50', value: 50 },
                        { label: '100', value: 100 },
                      ]}
                    />
                    <FormMessage className="basis-full text-xs" />
                  </FormItem>
                )}
              />

              <p className="text-xs text-muted-foreground">
                {t('settings.bittorrent.trackers.blacklistMovedInfo')}
              </p>
            </form>
          </Form>

          {/* Peer geo — self-contained form; rendered outside BT form to avoid nested <form> */}
          <div className="mt-4 border-t border-border pt-4">
            <BtPeerGeoSection ref={geoipRef} />
          </div>
        </div>

        <DialogFooter className="shrink-0 border-t border-border px-6 py-4">
          {form.formState.errors.root?.save && (
            <p role="alert" className="mr-auto text-xs text-destructive">
              {form.formState.errors.root.save.message}
            </p>
          )}
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
