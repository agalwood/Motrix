import { describe, expect, it, vi } from 'vitest'
import { PluginRuntimeStartupCoordinator } from './startup-coordinator'

describe('PluginRuntimeStartupCoordinator', () => {
  it('enforces finalize recovery, task recovery, drains, then producers', async () => {
    const calls: string[] = []
    const coordinator = new PluginRuntimeStartupCoordinator()

    await coordinator.recoverFinalize(async () => {
      calls.push('finalize')
    })
    coordinator.markTasksRecovered()
    await coordinator.drainBeforeProducers({
      drainOccurrences: async () => {
        calls.push('occurrences')
      },
      recoverAndDrainPostDeliveries: async () => {
        calls.push('post')
      },
    })
    coordinator.openProducers(() => calls.push('producers'))

    expect(calls).toEqual(['finalize', 'occurrences', 'post', 'producers'])
    expect(coordinator.currentPhase()).toBe('producers-open')
  })

  it('rejects delivery drain or producer admission before task recovery', async () => {
    const coordinator = new PluginRuntimeStartupCoordinator()
    await coordinator.recoverFinalize(async () => undefined)

    await expect(
      coordinator.drainBeforeProducers({
        drainOccurrences: vi.fn(),
        recoverAndDrainPostDeliveries: vi.fn(),
      })
    ).rejects.toThrow('expected tasks-recovered')
    expect(() => coordinator.openProducers(vi.fn())).toThrow('expected drained')
  })

  it('does not advance a phase when a recovery callback fails', async () => {
    const coordinator = new PluginRuntimeStartupCoordinator()
    await expect(
      coordinator.recoverFinalize(async () => {
        throw new Error('journal corrupt')
      })
    ).rejects.toThrow('journal corrupt')
    expect(coordinator.currentPhase()).toBe('runtime-ready')
  })

  it('does not allow the engine to start before finalize recovery', async () => {
    const calls: string[] = []
    const coordinator = new PluginRuntimeStartupCoordinator()

    await expect(
      coordinator.startEngine(async () => void calls.push('engine'))
    ).rejects.toThrow('expected finalize-recovered')
    await coordinator.recoverFinalize(async () => void calls.push('finalize'))
    await coordinator.startEngine(async () => void calls.push('engine'))

    expect(calls).toEqual(['finalize', 'engine'])
  })
})
