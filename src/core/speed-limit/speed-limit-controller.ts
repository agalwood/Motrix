import { getLogger } from '@core/logger'
import { Events } from '@shared/protocol/events'
import { EngineState } from '@shared/types/engine'
import type {
  SpeedLimitProfile,
  SpeedLimitReason,
  SpeedLimitSettings,
  TurtleState,
} from '@shared/types/settings'
import { computeEffectiveLimits, withinWindow } from './effective-limits'

const log = getLogger('speed-limit')

export type { SpeedLimitReason } from '@shared/types/settings'

export interface SpeedLimitState {
  turtle: TurtleState
  effective: SpeedLimitProfile
  activeReason: SpeedLimitReason
}

export interface SpeedLimitControllerDeps {
  getSettings: () => SpeedLimitSettings
  applyLimits: (limits: SpeedLimitProfile) => Promise<void>
  getEngineState: () => EngineState
  emit: (
    channel: typeof Events.SpeedLimitChanged,
    payload: SpeedLimitState
  ) => void
  /** Phase 2 hook; absent in Phase 1 → video-app never contributes. */
  isVideoAppRunning?: () => boolean
  /** Injectable for tests; defaults to real time. */
  now?: () => Date
}

const SCHEDULE_TICK_MS = 60_000

function sameProfile(a: SpeedLimitProfile, b: SpeedLimitProfile): boolean {
  return a.download === b.download && a.upload === b.upload
}

export class SpeedLimitController {
  private lastPushed: SpeedLimitProfile | null = null
  private scheduleTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private lifecycleGeneration = 0

  constructor(private readonly deps: SpeedLimitControllerDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date()
  }

  getEffective(): SpeedLimitProfile {
    return computeEffectiveLimits(this.deps.getSettings(), {
      now: this.now(),
      videoAppRunning: this.deps.isVideoAppRunning?.() ?? false,
    })
  }

  getState(): SpeedLimitState {
    const settings = this.deps.getSettings()
    const now = this.now()
    const videoAppRunning = this.deps.isVideoAppRunning?.() ?? false
    const effective = computeEffectiveLimits(settings, { now, videoAppRunning })
    return {
      turtle: settings.turtle,
      effective,
      activeReason: this.reasonFor(settings, now, videoAppRunning),
    }
  }

  private reasonFor(
    settings: SpeedLimitSettings,
    now: Date,
    videoAppRunning: boolean
  ): SpeedLimitReason {
    if (settings.turtle === 'off') {
      return settings.base.download > 0 || settings.base.upload > 0
        ? 'base'
        : 'none'
    }
    if (settings.turtle === 'on') return 'turtle' // alt + base both active; trigger is the forced state
    // turtle === 'auto'
    const { schedule, videoApp, adaptive } = settings.auto
    if (schedule.enabled && withinWindow(now, schedule)) {
      return 'schedule'
    }
    if (videoApp.enabled && videoAppRunning) {
      return 'videoApp'
    }
    if (adaptive.enabled) return 'adaptive'
    return 'none'
  }

  /** Recompute, push to engine if Ready and changed, and emit the event. */
  async recompute(): Promise<void> {
    if (this.stopped) return
    const generation = this.lifecycleGeneration
    const state = this.getState()
    if (
      this.deps.getEngineState() === EngineState.Ready &&
      (this.lastPushed === null ||
        !sameProfile(this.lastPushed, state.effective))
    ) {
      try {
        await this.deps.applyLimits(state.effective)
        if (!this.isCurrent(generation)) return
        this.lastPushed = state.effective
      } catch (err) {
        if (this.isCurrent(generation)) {
          log.error({ err }, 'failed to apply speed limits')
        }
      }
    }
    if (!this.isCurrent(generation)) return
    this.deps.emit(Events.SpeedLimitChanged, state)
  }

  /** Call when the engine reaches Ready (forces a push). */
  async onEngineReady(): Promise<void> {
    if (this.stopped) return
    this.lastPushed = null
    await this.recompute()
  }

  start(): void {
    if (this.scheduleTimer) return
    this.stopped = false
    const generation = this.lifecycleGeneration
    this.scheduleTimer = setInterval(() => {
      if (!this.isCurrent(generation)) return
      void this.recompute()
    }, SCHEDULE_TICK_MS)
    void this.recompute()
  }

  stop(): void {
    if (!this.stopped) {
      this.stopped = true
      this.lifecycleGeneration += 1
    }
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer)
      this.scheduleTimer = null
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.stopped && this.lifecycleGeneration === generation
  }
}
