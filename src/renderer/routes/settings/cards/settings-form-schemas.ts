import { appSettingsInputSchema } from '@shared/schemas/app-settings'
import { engineSettingsInputSchema } from '@shared/schemas/engine-settings'
import { geoIpSettingsInputSchema } from '@shared/schemas/geoip-settings'
import { mediaSettingsInputSchema } from '@shared/schemas/media-settings'
import { natSettingsInputSchema } from '@shared/schemas/nat-settings'
import { proxySettingsInputSchema } from '@shared/schemas/proxy-settings'
import { trackerSettingsInputSchema } from '@shared/schemas/tracker-settings'
import { z } from 'zod'

export const generalFormSchema = appSettingsInputSchema.pick({
  launchAtStartup: true,
  showMainWindowAtLogin: true,
  notifyOnComplete: true,
  notifyOnError: true,
  notifyInAppOnComplete: true,
  notifyInAppOnError: true,
  notificationBadgeStyle: true,
  warnBeforeQuit: true,
  runMode: true,
  lightweightMode: true,
})

export const appearanceFormSchema = appSettingsInputSchema.pick({
  theme: true,
  sidebarColor: true,
  reduceMotion: true,
  language: true,
  byteUnitSystem: true,
  traySpeedometer: true,
  trayIconColor: true,
  liquidGlassEffect: true,
})

export const advancedFormSchema = engineSettingsInputSchema.pick({
  sessionSaveInterval: true,
  rpcPort: true,
  rpcSecret: true,
  sqlite3Persistence: true,
  sqlite3DbPath: true,
  sqlite3HistoryLimit: true,
})

export const networkFormSchema = z.object({
  proxy: proxySettingsInputSchema,
  nat: natSettingsInputSchema,
  engine: engineSettingsInputSchema.pick({ dnsMode: true }),
})

export const bitTorrentFormSchema = z.object({
  geoip: geoIpSettingsInputSchema,
  engine: engineSettingsInputSchema.pick({
    magnetResolveTimeout: true,
    listenPort: true,
    dhtListenPort: true,
    dhtEnabled: true,
    btMaxPeers: true,
    btEnableLpd: true,
    seedRatio: true,
    seedTime: true,
  }),
  app: appSettingsInputSchema.pick({
    magnetFileSelection: true,
    magnetFileSelectionAutoDownload: true,
    magnetFileSelectionTimeoutSeconds: true,
  }),
  tracker: trackerSettingsInputSchema.pick({
    autoSync: true,
    syncIntervalHours: true,
    probeEnabled: true,
    probeTimeoutMs: true,
    healthyThresholdMs: true,
    minSuccessRate: true,
    maxTrackerCount: true,
  }),
})

export const integrationFormSchema = z.object({
  app: appSettingsInputSchema.pick({
    browserBridgeEnabled: true,
    protocols: true,
  }),
  media: mediaSettingsInputSchema,
})
