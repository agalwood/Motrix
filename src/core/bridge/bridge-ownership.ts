type BridgeCleanup = () => void | Promise<void>

interface OwnedCleanup {
  label: string
  cleanup: BridgeCleanup
}

/**
 * Small async ownership ledger for bridge bootstrap. Resources are released in
 * reverse acquisition order, every cleanup is attempted, and disposal is
 * idempotent so startup rollback can share the exact runtime shutdown path.
 */
export class BridgeOwnership {
  private readonly owned: OwnedCleanup[] = []
  private disposePromise: Promise<void> | null = null

  own(label: string, cleanup: BridgeCleanup): void {
    if (this.disposePromise) {
      throw new Error(`cannot acquire bridge resource after disposal: ${label}`)
    }
    this.owned.push({ label, cleanup })
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposePromise = this.disposeOwned()
    return this.disposePromise
  }

  async rollback(primaryError: unknown): Promise<never> {
    try {
      await this.dispose()
    } catch (cleanupError) {
      const cleanupErrors =
        cleanupError instanceof AggregateError
          ? cleanupError.errors
          : [cleanupError]
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        'Bridge startup failed and rollback was incomplete'
      )
    }
    throw primaryError
  }

  private async disposeOwned(): Promise<void> {
    const errors: Array<Error> = []
    for (const { label, cleanup } of this.owned.reverse()) {
      try {
        await cleanup()
      } catch (error) {
        errors.push(
          new Error(`bridge cleanup failed: ${label}`, {
            cause: error,
          })
        )
      }
    }
    this.owned.length = 0
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Multiple bridge cleanup steps failed')
    }
  }
}
