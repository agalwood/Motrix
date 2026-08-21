import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ENGINE_PERFORMANCE_TUNING_KEYS } from '@shared/constants/engine-performance-profiles'
import {
  APP_RESTART_REQUIRED_KEYS,
  ENGINE_RESTART_REQUIRED_KEYS,
} from '@shared/constants/restart-keys'
import type { BridgeSettings } from '@shared/schemas/bridge-settings'
import {
  bridgeSettingsSchema,
  DEFAULT_BRIDGE_SETTINGS,
} from '@shared/schemas/bridge-settings'
import {
  DEFAULT_PROXY_SETTINGS,
  proxySettingsSchema,
} from '@shared/schemas/proxy-settings'
import type { GeoIPSettings } from '@shared/types/geoip'
import type {
  AppSettings,
  DashboardLayoutSettings,
  EngineSettings,
  MediaSettings,
  MotrixAppSettings,
  NatSettings,
  OnboardingState,
  ProxySettings,
  SpeedLimitSettings,
  TrackerSettings,
} from '@shared/types/settings'
import { generateRpcSecret } from '@shared/utils/rpc-secret'
import writeFileAtomic from 'write-file-atomic'
import { CURRENT_SETTINGS_VERSION, migrate } from './migrations'
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_ENGINE_SETTINGS,
  DEFAULT_GEOIP_SETTINGS,
  DEFAULT_MEDIA_SETTINGS,
  DEFAULT_NAT_SETTINGS,
  DEFAULT_ONBOARDING_STATE,
  DEFAULT_SPEED_LIMIT_SETTINGS,
  DEFAULT_TRACKER_SETTINGS,
  geoIpSettingsSchema,
  mediaSettingsSchema,
  onboardingStateSchema,
  validateAppSettings,
  validateDashboardLayoutSettings,
  validateEngineSettings,
  validateNatSettings,
  validateSpeedLimitSettings,
  validateTrackerSettings,
  windowStateSchema,
} from './validators'

export interface UpdateResult {
  saved: boolean
  requiresRestart: boolean
  changedRestartKeys: string[]
  requiresAppRestart: boolean
  changedAppRestartKeys: string[]
}

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

// Deep-merge a partial patch into a base object: recurse into plain
// objects key-by-key, but replace arrays and primitives wholesale.
// Used for the speedLimit namespace, whose `auto.*` tree is deeply
// nested — a shallow spread would drop sibling sub-fields and let
// Zod .catch() silently refill them with schema defaults.
function deepMerge<T extends Record<string, unknown>>(
  base: T,
  patch: Record<string, unknown>
): T {
  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(patch)) {
    const patchValue = patch[key]
    const baseValue = result[key]
    if (isPlainObject(patchValue) && isPlainObject(baseValue)) {
      result[key] = deepMerge(baseValue, patchValue)
    } else {
      result[key] = patchValue
    }
  }
  return result as T
}

function deepMergeSpeedLimit(
  base: SpeedLimitSettings,
  patch: DeepPartial<SpeedLimitSettings>
): SpeedLimitSettings {
  return deepMerge(
    base as unknown as Record<string, unknown>,
    patch as Record<string, unknown>
  ) as unknown as SpeedLimitSettings
}

function createDefaultSettings(
  liquidGlassEffectDefault = DEFAULT_APP_SETTINGS.liquidGlassEffect
): AppSettings {
  return {
    version: CURRENT_SETTINGS_VERSION,
    engine: { ...DEFAULT_ENGINE_SETTINGS },
    app: {
      ...DEFAULT_APP_SETTINGS,
      liquidGlassEffect: liquidGlassEffectDefault,
    },
    onboarding: { ...DEFAULT_ONBOARDING_STATE },
    nat: { ...DEFAULT_NAT_SETTINGS },
    proxy: { ...DEFAULT_PROXY_SETTINGS },
    plugins: {},
    tracker: { ...DEFAULT_TRACKER_SETTINGS },
    geoip: { ...DEFAULT_GEOIP_SETTINGS },
    media: { ...DEFAULT_MEDIA_SETTINGS },
    dashboard: validateDashboardLayoutSettings({} as DashboardLayoutSettings),
    speedLimit: { ...DEFAULT_SPEED_LIMIT_SETTINGS },
    // Fresh install: mint a real, durable instance id now rather than
    // persisting the '' sentinel. Unlike rpcSecret/defaultSaveDir (seeded
    // later by seedSentinels using instance-scoped defaults), the UUID
    // needs no runtime context, so it is generated directly here.
    bridge: { ...DEFAULT_BRIDGE_SETTINGS, instanceId: randomUUID() },
    windowState: {},
  }
}

function hasPersistedRpcSecret(settings: Record<string, unknown>): boolean {
  return (
    isPlainObject(settings.engine) &&
    typeof settings.engine.rpcSecret === 'string'
  )
}

export interface SettingsManagerOptions {
  defaultSaveDir?: string
  isLegacyDefaultSaveDir?: (value: string) => boolean
  liquidGlassEffectDefault?: boolean
  onChange?: (old: AppSettings, updated: AppSettings) => void
}

export class SettingsManager {
  private settings: AppSettings
  private readonly defaultSaveDir: string
  private readonly isLegacyDefaultSaveDir?: (value: string) => boolean
  private readonly liquidGlassEffectDefault: boolean
  private readonly onChange?: (old: AppSettings, updated: AppSettings) => void
  // Keep durable writes, in-memory commits, and change notifications in the
  // same order across every settings mutation entry point.
  private mutationTail: Promise<void> = Promise.resolve()

  constructor(
    private filePath: string,
    opts?: SettingsManagerOptions
  ) {
    this.liquidGlassEffectDefault =
      opts?.liquidGlassEffectDefault ?? DEFAULT_APP_SETTINGS.liquidGlassEffect
    this.settings = createDefaultSettings(this.liquidGlassEffectDefault)
    this.defaultSaveDir =
      opts?.defaultSaveDir ?? path.join(os.homedir(), 'Downloads')
    if (!path.isAbsolute(this.defaultSaveDir)) {
      throw new Error('defaultSaveDir must be absolute')
    }
    this.isLegacyDefaultSaveDir = opts?.isLegacyDefaultSaveDir
    this.onChange = opts?.onChange
  }

  async load(): Promise<void> {
    let parsed: Record<string, unknown>
    let seedMissingRpcSecret = true

    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const decoded: unknown = JSON.parse(raw)
      if (!isPlainObject(decoded)) {
        throw new Error('settings root must be an object')
      }
      parsed = decoded
      const migrated = migrate(parsed)
      // Empty is a supported explicit choice (local RPC with no token), while
      // a missing or invalid field keeps the secure generated first-run
      // default. Check presence after migration so legacy shapes participate.
      seedMissingRpcSecret = !hasPersistedRpcSecret(migrated)
      this.settings = this.buildValidSettings(migrated as Partial<AppSettings>)
    } catch {
      // File missing, corrupt, or unreadable — use defaults
      this.settings = createDefaultSettings(this.liquidGlassEffectDefault)
      this.seedSentinels(true)
      await this.save()
      return
    }

    // Keep persistence outside the read/parse recovery block. A failed
    // backfill write must surface to the caller instead of being mistaken for
    // corrupt input and overwriting otherwise-valid user settings with
    // defaults.
    const seeded = this.seedSentinels(seedMissingRpcSecret)
    const versionStale =
      !parsed.version || parsed.version !== CURRENT_SETTINGS_VERSION
    if (seeded || versionStale) {
      await this.save()
    }
  }

  private seedSentinels(seedMissingRpcSecret: boolean): boolean {
    let changed = false
    if (seedMissingRpcSecret && this.settings.engine.rpcSecret === '') {
      this.settings.engine.rpcSecret = generateRpcSecret()
      changed = true
    }
    const currentSaveDir = this.settings.app.defaultSaveDir
    if (
      currentSaveDir === '' ||
      this.isLegacyDefaultSaveDir?.(currentSaveDir) === true
    ) {
      this.settings.app.defaultSaveDir = this.defaultSaveDir
      changed = true
    }
    return changed
  }

  async save(): Promise<void> {
    await this.saveSettings(this.settings)
  }

  private async saveSettings(settings: AppSettings): Promise<void> {
    const dir = path.dirname(this.filePath)
    await mkdir(dir, { recursive: true })
    // Atomic: writes to <path>.<rand>, fsyncs, renames over the
    // target. Crash mid-write leaves the OLD settings.json intact —
    // critical because losing user-customized fields silently resets the app.
    await writeFileAtomic(this.filePath, JSON.stringify(settings, null, 2), {
      encoding: 'utf-8',
    })
  }

  get(): AppSettings {
    return this.settings
  }

  getEngine(): EngineSettings {
    return this.settings.engine
  }

  getApp(): MotrixAppSettings {
    return this.settings.app
  }

  getProxy(): ProxySettings {
    return this.settings.proxy
  }

  getMedia(): MediaSettings {
    return this.settings.media
  }

  /**
   * Persist legal consent transactionally. The in-memory flag only changes
   * after the atomic write succeeds, so a later unrelated settings save
   * cannot accidentally commit consent from a failed attempt.
   */
  async acceptDisclaimer(): Promise<UpdateResult> {
    return this.enqueueMutation(() => this.persistDisclaimerAcceptance())
  }

  async setDisclaimerLanguage(
    language: MotrixAppSettings['language']
  ): Promise<UpdateResult> {
    return this.enqueueMutation(async () => {
      if (this.settings.app.language === language) {
        return this.unchangedResult()
      }

      const old = structuredClone(this.settings)
      const next = structuredClone(this.settings)
      next.app = validateAppSettings({ ...next.app, language })

      await this.saveSettings(next)
      this.settings = next
      this.onChange?.(old, this.settings)

      return {
        saved: true,
        requiresRestart: false,
        changedRestartKeys: [],
        requiresAppRestart: false,
        changedAppRestartKeys: [],
      }
    })
  }

  private async persistDisclaimerAcceptance(): Promise<UpdateResult> {
    if (this.settings.onboarding.disclaimerAccepted) {
      return this.unchangedResult()
    }

    const old = structuredClone(this.settings)
    const next = structuredClone(this.settings)
    next.onboarding = onboardingStateSchema.parse({
      ...next.onboarding,
      disclaimerAccepted: true,
    })

    await this.saveSettings(next)
    this.settings = next
    this.onChange?.(old, this.settings)

    return {
      saved: true,
      requiresRestart: false,
      changedRestartKeys: [],
      requiresAppRestart: false,
      changedAppRestartKeys: [],
    }
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const pending = this.mutationTail.then(mutation, mutation)
    this.mutationTail = pending.then(
      () => undefined,
      () => undefined
    )
    return pending
  }

  private unchangedResult(): UpdateResult {
    return {
      saved: false,
      requiresRestart: false,
      changedRestartKeys: [],
      requiresAppRestart: false,
      changedAppRestartKeys: [],
    }
  }

  async update(partial: DeepPartial<AppSettings>): Promise<UpdateResult> {
    const patch = structuredClone(partial)
    return this.enqueueMutation(() => this.persistUpdate(patch))
  }

  /**
   * Remove the durable configuration namespace owned by an uninstalled
   * plugin. A normal partial update cannot express deletion because plugin
   * settings are merge-patched, so uninstall uses this explicit atomic
   * operation instead of leaving encrypted secrets and stale configuration
   * behind forever.
   */
  async removePluginConfig(pluginId: string): Promise<UpdateResult> {
    return this.enqueueMutation(async () => {
      if (!Object.hasOwn(this.settings.plugins, pluginId)) {
        return this.unchangedResult()
      }

      const old = structuredClone(this.settings)
      const next = structuredClone(this.settings)
      delete next.plugins[pluginId]
      await this.saveSettings(next)
      this.settings = next
      this.onChange?.(old, this.settings)
      return {
        saved: true,
        requiresRestart: false,
        changedRestartKeys: [],
        requiresAppRestart: false,
        changedAppRestartKeys: [],
      }
    })
  }

  private async persistUpdate(
    partial: DeepPartial<AppSettings>
  ): Promise<UpdateResult> {
    const old = structuredClone(this.settings)
    const next = structuredClone(this.settings)
    const changedRestartKeys: string[] = []
    const changedAppRestartKeys: string[] = []

    // Merge engine settings
    if (partial.engine) {
      if (
        Object.hasOwn(partial.engine, 'rpcSecret') &&
        typeof partial.engine.rpcSecret !== 'string'
      ) {
        // The schema's `.catch('')` is intentionally tolerant while loading
        // damaged legacy files. At the live update boundary, however, only a
        // literal string (including explicit "") may change authentication.
        throw new TypeError(
          'settings.engine.rpcSecret must be a string when provided'
        )
      }
      const merged = { ...next.engine, ...partial.engine }
      if (
        partial.engine.performanceProfile === undefined &&
        ENGINE_PERFORMANCE_TUNING_KEYS.some(
          (key) => partial.engine?.[key] !== undefined
        )
      ) {
        merged.performanceProfile = 'custom'
      }
      const validated = validateEngineSettings(merged as EngineSettings)

      // Detect restart-required key changes
      for (const key of ENGINE_RESTART_REQUIRED_KEYS) {
        if (validated[key] !== next.engine[key]) {
          changedRestartKeys.push(key)
        }
      }

      next.engine = validated
    }

    // Merge app settings
    if (partial.app) {
      const merged = { ...next.app, ...partial.app }
      const validated = validateAppSettings(merged as MotrixAppSettings)

      // Detect app-namespace restart-required key changes
      for (const key of Object.keys(partial.app) as Array<
        keyof MotrixAppSettings
      >) {
        if (
          APP_RESTART_REQUIRED_KEYS.has(key) &&
          validated[key] !== next.app[key]
        ) {
          changedAppRestartKeys.push(key)
        }
      }

      next.app = validated
    }

    // Merge the disclaimer consent namespace without replacing future-safe
    // defaults when callers submit a partial onboarding patch.
    if (partial.onboarding) {
      next.onboarding = onboardingStateSchema.parse({
        ...next.onboarding,
        ...(partial.onboarding as Partial<OnboardingState>),
      })
    }

    // Merge nat settings
    if (partial.nat) {
      const merged = { ...next.nat, ...partial.nat }
      next.nat = validateNatSettings(merged as NatSettings)
    }

    // Merge proxy settings. proxy has a nested `scopes` object, so — like
    // speedLimit — deep-merge it: a partial scopes patch (e.g. only the dirty
    // toggle) must not let proxySettingsSchema's .catch() refill the sibling
    // scopes with defaults and silently wipe them. (This branch was missing
    // entirely, so proxy updates from the Network settings UI were dropped.)
    if (partial.proxy) {
      const merged = {
        ...next.proxy,
        ...partial.proxy,
        scopes: {
          ...next.proxy.scopes,
          ...(partial.proxy.scopes ?? {}),
        },
      }
      next.proxy = proxySettingsSchema.parse(merged as ProxySettings)
    }

    // Merge tracker settings
    if (partial.tracker) {
      const merged = { ...next.tracker, ...partial.tracker }
      next.tracker = validateTrackerSettings(merged as TrackerSettings)
    }

    // Merge geoip settings — hot-reloaded by GeoIPManager via onChange.
    if (partial.geoip) {
      const merged = { ...next.geoip, ...partial.geoip }
      next.geoip = geoIpSettingsSchema.parse(merged as GeoIPSettings)
    }

    // Merge media settings — read by ffmpeg detect / staging quota; restart
    // required for ffmpegBinaryPath to take effect inside the plugin runtime.
    if (partial.media) {
      const merged = { ...next.media, ...partial.media }
      next.media = mediaSettingsSchema.parse(merged as MediaSettings)
    }

    // Merge dashboard layout settings.
    if (partial.dashboard) {
      const merged = { ...next.dashboard, ...partial.dashboard }
      next.dashboard = validateDashboardLayoutSettings(
        merged as DashboardLayoutSettings
      )
    }

    // Merge speed limit settings. Unlike the flat namespaces above,
    // speedLimit has a deeply nested `auto.*` tree, so a shallow spread
    // would drop sibling sub-fields and let Zod .catch() refill them
    // with schema defaults — silently wiping saved values. Deep-merge
    // (recursing plain objects, replacing arrays/primitives) before
    // validating.
    if (partial.speedLimit) {
      next.speedLimit = validateSpeedLimitSettings(
        deepMergeSpeedLimit(
          next.speedLimit,
          partial.speedLimit
        ) as SpeedLimitSettings
      )
    }

    // Merge bridge settings. `instanceId` uses `.catch('')`
    // (bridge-settings.ts), so parsing a partial patch on its own would
    // silently reset the durable instance id to the unseeded '' sentinel —
    // there is no repair path once that happens (seeding runs only for
    // fresh defaults and the v8->v9 migration). Merge onto the current
    // value first, exactly like proxy/speedLimit above.
    if (partial.bridge) {
      next.bridge = bridgeSettingsSchema.parse({
        ...next.bridge,
        ...partial.bridge,
      })
    }

    // Merge plugins
    if (partial.plugins !== undefined) {
      next.plugins = {
        ...next.plugins,
        ...(partial.plugins as AppSettings['plugins']),
      }
    }

    // Merge windowState
    if (partial.windowState !== undefined) {
      next.windowState = windowStateSchema.parse({
        ...next.windowState,
        ...partial.windowState,
      })
    }

    await this.saveSettings(next)

    this.settings = next
    this.onChange?.(old, this.settings)

    return {
      saved: true,
      requiresRestart: changedRestartKeys.length > 0,
      changedRestartKeys,
      requiresAppRestart: changedAppRestartKeys.length > 0,
      changedAppRestartKeys,
    }
  }

  private buildValidSettings(raw: Partial<AppSettings>): AppSettings {
    let appInput: unknown = raw.app ?? {}
    if (
      isPlainObject(appInput) &&
      !Object.hasOwn(appInput, 'liquidGlassEffect')
    ) {
      appInput = {
        ...appInput,
        liquidGlassEffect: this.liquidGlassEffectDefault,
      }
    }

    return {
      version: CURRENT_SETTINGS_VERSION,
      engine: validateEngineSettings((raw.engine ?? {}) as EngineSettings),
      app: validateAppSettings(appInput as MotrixAppSettings),
      onboarding: onboardingStateSchema.parse(raw.onboarding ?? {}),
      nat: validateNatSettings((raw.nat ?? {}) as NatSettings),
      proxy: proxySettingsSchema.parse({
        ...DEFAULT_PROXY_SETTINGS,
        ...((raw.proxy ?? {}) as Partial<ProxySettings>),
      }),
      plugins: raw.plugins ?? {},
      tracker: validateTrackerSettings((raw.tracker ?? {}) as TrackerSettings),
      geoip: geoIpSettingsSchema.parse((raw.geoip ?? {}) as GeoIPSettings),
      media: mediaSettingsSchema.parse((raw.media ?? {}) as MediaSettings),
      dashboard: validateDashboardLayoutSettings(
        (raw.dashboard ?? {}) as DashboardLayoutSettings
      ),
      speedLimit: validateSpeedLimitSettings(
        (raw.speedLimit ?? {}) as SpeedLimitSettings
      ),
      bridge: bridgeSettingsSchema.parse((raw.bridge ?? {}) as BridgeSettings),
      windowState: windowStateSchema.parse(raw.windowState ?? {}),
    }
  }
}
