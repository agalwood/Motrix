import { DEFAULT_SPEED_LIMIT_SETTINGS } from '@shared/schemas/speed-limit'
import { EngineState } from '@shared/types/engine'
import type { SpeedLimitSettings } from '@shared/types/settings'
import { describe, expect, it, vi } from 'vitest'
import { SpeedLimitController } from './speed-limit-controller'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve
  })
  return { promise, resolve }
}

function makeDeps(over: Partial<SpeedLimitSettings> = {}) {
  const settings: SpeedLimitSettings = {
    ...structuredClone(DEFAULT_SPEED_LIMIT_SETTINGS),
    ...over,
  }
  const applyLimits = vi.fn().mockResolvedValue(undefined)
  const emit = vi.fn()
  let engineState = EngineState.Ready
  const controller = new SpeedLimitController({
    getSettings: () => settings,
    applyLimits,
    getEngineState: () => engineState,
    emit,
  })
  return {
    controller,
    applyLimits,
    emit,
    setEngineState: (s: EngineState) => {
      engineState = s
    },
  }
}

describe('SpeedLimitController', () => {
  it('getEffective reflects an off-turtle base limit', () => {
    const { controller } = makeDeps({
      turtle: 'off',
      base: { download: 700, upload: 70 },
    })
    expect(controller.getEffective()).toEqual({ download: 700, upload: 70 })
  })

  it('recompute pushes to the engine when Ready and emits the event', async () => {
    const { controller, applyLimits, emit } = makeDeps({
      turtle: 'off',
      base: { download: 700, upload: 70 },
    })
    await controller.recompute()
    expect(applyLimits).toHaveBeenCalledWith({ download: 700, upload: 70 })
    expect(emit).toHaveBeenCalledWith(
      'event:speedLimitChanged',
      expect.objectContaining({
        turtle: 'off',
        effective: { download: 700, upload: 70 },
        activeReason: 'base',
      })
    )
  })

  it('does not push when not Ready', async () => {
    const { controller, applyLimits, setEngineState } = makeDeps({
      turtle: 'off',
      base: { download: 700, upload: 70 },
    })
    setEngineState(EngineState.Stopped)
    await controller.recompute()
    expect(applyLimits).not.toHaveBeenCalled()
  })

  it('does not re-push when effective is unchanged', async () => {
    const { controller, applyLimits } = makeDeps({
      turtle: 'off',
      base: { download: 700, upload: 70 },
    })
    await controller.recompute()
    await controller.recompute()
    expect(applyLimits).toHaveBeenCalledTimes(1)
  })

  it('does not publish when stop wins an in-flight recompute', async () => {
    const applying = deferred()
    const applyStarted = deferred()
    const emit = vi.fn()
    const controller = new SpeedLimitController({
      getSettings: () => ({
        ...structuredClone(DEFAULT_SPEED_LIMIT_SETTINGS),
        base: { download: 700, upload: 70 },
      }),
      applyLimits: async () => {
        applyStarted.resolve()
        await applying.promise
      },
      getEngineState: () => EngineState.Ready,
      emit,
    })

    const recomputing = controller.recompute()
    await applyStarted.promise
    controller.stop()
    applying.resolve()
    await recomputing

    expect(emit).not.toHaveBeenCalled()
  })

  it('getState returns turtle + effective + reason (off, no base)', () => {
    const { controller } = makeDeps({ turtle: 'off' })
    expect(controller.getState()).toEqual({
      turtle: 'off',
      effective: { download: 0, upload: 0 },
      activeReason: 'none',
    })
  })

  it('reports none when auto + schedule enabled but outside its window', () => {
    const settings: SpeedLimitSettings = structuredClone(
      DEFAULT_SPEED_LIMIT_SETTINGS
    )
    settings.turtle = 'auto'
    settings.auto.schedule = {
      enabled: true,
      from: '23:00',
      to: '07:00',
      days: [],
    }
    const now = new Date('2026-06-09T12:00:00') // outside 23:00–07:00
    const controller = new SpeedLimitController({
      getSettings: () => settings,
      applyLimits: vi.fn().mockResolvedValue(undefined),
      getEngineState: () => EngineState.Ready,
      emit: vi.fn(),
      now: () => now,
    })
    expect(controller.getState()).toEqual({
      turtle: 'auto',
      effective: { download: 0, upload: 0 },
      activeReason: 'none',
    })
  })

  it('reports videoApp when auto + the video-app probe is active', () => {
    const settings: SpeedLimitSettings = structuredClone(
      DEFAULT_SPEED_LIMIT_SETTINGS
    )
    settings.turtle = 'auto'
    settings.auto.videoApp = { enabled: true, processNames: ['mpv'] }
    const now = new Date('2026-06-09T12:00:00')
    const controller = new SpeedLimitController({
      getSettings: () => settings,
      applyLimits: vi.fn().mockResolvedValue(undefined),
      getEngineState: () => EngineState.Ready,
      emit: vi.fn(),
      isVideoAppRunning: () => true,
      now: () => now,
    })
    expect(controller.getState().activeReason).toBe('videoApp')
  })

  it('reports turtle when forced on', () => {
    const { controller } = makeDeps({ turtle: 'on' })
    expect(controller.getState().activeReason).toBe('turtle')
  })

  it('reports turtle (not base) when forced on with a base limit', () => {
    const { controller } = makeDeps({
      turtle: 'on',
      base: { download: 700, upload: 70 },
    })
    expect(controller.getState().activeReason).toBe('turtle')
  })
})
