export interface ArtifactWriterQuiescer {
  quiesce(taskId: string): Promise<() => Promise<void> | void>
}

export interface ArtifactMutationLease {
  readonly taskId: string
  release(): Promise<void>
}

export class ArtifactMutationLeaseCoordinator {
  private readonly active = new Set<string>()

  constructor(private readonly writers: readonly ArtifactWriterQuiescer[]) {}

  async acquire(taskId: string): Promise<ArtifactMutationLease> {
    if (this.active.has(taskId)) {
      throw new Error(`artifact mutation lease is already held for ${taskId}`)
    }
    this.active.add(taskId)
    const resumptions: Array<() => Promise<void> | void> = []
    try {
      for (const writer of this.writers) {
        resumptions.push(await writer.quiesce(taskId))
      }
    } catch (error) {
      for (const resume of resumptions.reverse()) await resume()
      this.active.delete(taskId)
      throw error
    }
    let released = false
    return {
      taskId,
      release: async () => {
        if (released) return
        released = true
        let firstError: unknown
        for (const resume of resumptions.reverse()) {
          try {
            await resume()
          } catch (error) {
            firstError ??= error
          }
        }
        this.active.delete(taskId)
        if (firstError) throw firstError
      },
    }
  }

  isHeld(taskId: string): boolean {
    return this.active.has(taskId)
  }
}
