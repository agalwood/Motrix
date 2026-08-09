export class AsyncWorkTracker {
  private accepting = true
  private readonly inFlight = new Set<Promise<unknown>>()
  private drainPromise: Promise<void> | null = null

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.accepting) {
      return Promise.reject(new Error('AsyncWorkTracker is stopped'))
    }

    const work = Promise.resolve().then(operation)
    this.inFlight.add(work)
    void work.then(
      () => this.inFlight.delete(work),
      () => this.inFlight.delete(work)
    )
    return work
  }

  isAccepting(): boolean {
    return this.accepting
  }

  stopAndDrain(): Promise<void> {
    if (this.drainPromise) return this.drainPromise
    this.accepting = false
    this.drainPromise = this.drainAcceptedWork()
    return this.drainPromise
  }

  private async drainAcceptedWork(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight])
    }
  }
}
