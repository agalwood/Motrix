/**
 * Serializes backend-catalog mutations with endpoint-scoped pairing actions.
 * The queue covers both storage work and active-connection side effects, so a
 * delayed operation for backend A cannot stop or clear the gate for backend B.
 */
export class BackendOperationCoordinator {
  private operationTail: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
