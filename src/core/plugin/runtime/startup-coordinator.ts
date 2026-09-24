export type PluginRuntimeStartupPhase =
  | 'runtime-ready'
  | 'finalize-recovered'
  | 'tasks-recovered'
  | 'drained'
  | 'producers-open'

/**
 * Enforces the cross-shell recovery barrier. The callbacks stay shell-owned,
 * but neither shell can drain post deliveries or open producers out of order.
 */
export class PluginRuntimeStartupCoordinator {
  private phase: PluginRuntimeStartupPhase = 'runtime-ready'

  currentPhase(): PluginRuntimeStartupPhase {
    return this.phase
  }

  async recoverFinalize(recover: () => Promise<void>): Promise<void> {
    this.assertPhase('runtime-ready')
    await recover()
    this.phase = 'finalize-recovered'
  }

  async startEngine(start: () => Promise<void>): Promise<void> {
    this.assertPhase('finalize-recovered')
    await start()
  }

  markTasksRecovered(): void {
    this.assertPhase('finalize-recovered')
    this.phase = 'tasks-recovered'
  }

  async drainBeforeProducers(input: {
    drainOccurrences: () => Promise<void>
    recoverAndDrainPostDeliveries: () => Promise<void>
  }): Promise<void> {
    this.assertPhase('tasks-recovered')
    await input.drainOccurrences()
    await input.recoverAndDrainPostDeliveries()
    this.phase = 'drained'
  }

  openProducers(open: () => void): void {
    this.assertPhase('drained')
    open()
    this.phase = 'producers-open'
  }

  private assertPhase(expected: PluginRuntimeStartupPhase): void {
    if (this.phase !== expected) {
      throw new Error(
        `plugin runtime startup phase violation: expected ${expected}, got ${this.phase}`
      )
    }
  }
}
