export class TransitionMutex {
  private locked = false
  private holder: string | null = null
  private acquiredAt = 0

  async runExclusive<T>(fn: () => Promise<T>, name = 'anonymous'): Promise<T> {
    if (this.locked) {
      const err = new Error(
        `TransitionMutex busy (held by: ${this.holder ?? 'unknown'}, ` +
          `heldForMs: ${Date.now() - this.acquiredAt}, ` +
          `requestedBy: ${name})`
      )
      // Attach structured fields so pino logs them as discrete keys rather
      // than parsing from the message string.
      Object.assign(err, {
        mutexHolder: this.holder,
        mutexHeldForMs: Date.now() - this.acquiredAt,
        mutexRequester: name,
      })
      throw err
    }
    this.locked = true
    this.holder = name
    this.acquiredAt = Date.now()
    try {
      return await fn()
    } finally {
      this.locked = false
      this.holder = null
      this.acquiredAt = 0
    }
  }

  get isLocked(): boolean {
    return this.locked
  }

  get currentHolder(): string | null {
    return this.holder
  }
}

export class GenerationGuard {
  private generation = 0

  current(): number {
    return this.generation
  }

  bump(): number {
    this.generation++
    return this.generation
  }

  isCurrent(gen: number): boolean {
    return gen === this.generation
  }
}
