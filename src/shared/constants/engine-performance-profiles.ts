export const MAX_CONNECTIONS_PER_SERVER = 64

export const ENGINE_PERFORMANCE_PROFILE_IDS = [
  'auto',
  'balanced',
  'high',
  'maximum',
  'custom',
] as const

export type EnginePerformanceProfile =
  (typeof ENGINE_PERFORMANCE_PROFILE_IDS)[number]

export interface EnginePerformanceTuningValues {
  maxConnectionPerServer: number
  split: number
  minSplitSize: number
}

export const ENGINE_PERFORMANCE_TUNING_KEYS = [
  'maxConnectionPerServer',
  'split',
  'minSplitSize',
] as const satisfies readonly (keyof EnginePerformanceTuningValues)[]

const MB = 1024 * 1024

export const ENGINE_PERFORMANCE_PROFILES = {
  auto: {
    maxConnectionPerServer: MAX_CONNECTIONS_PER_SERVER,
    split: 16,
    minSplitSize: 4 * MB,
  },
  balanced: {
    maxConnectionPerServer: 16,
    split: 16,
    minSplitSize: 10 * MB,
  },
  high: {
    maxConnectionPerServer: 32,
    split: 32,
    minSplitSize: 4 * MB,
  },
  maximum: {
    maxConnectionPerServer: MAX_CONNECTIONS_PER_SERVER,
    split: 64,
    minSplitSize: 1 * MB,
  },
} as const satisfies Record<
  Exclude<EnginePerformanceProfile, 'custom'>,
  EnginePerformanceTuningValues
>

export function getEnginePerformanceProfileValues(
  profile: EnginePerformanceProfile
): EnginePerformanceTuningValues | null {
  return profile === 'custom' ? null : ENGINE_PERFORMANCE_PROFILES[profile]
}

export function applyEnginePerformanceProfile<
  T extends EnginePerformanceTuningValues & {
    performanceProfile: EnginePerformanceProfile
  },
>(settings: T): T {
  const values = getEnginePerformanceProfileValues(settings.performanceProfile)
  return values ? { ...settings, ...values } : settings
}
