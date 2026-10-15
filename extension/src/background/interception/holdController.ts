/** IO seams for one held filename determination. */
export interface HoldIo {
  suggest: () => void
  cancel: () => Promise<void>
  erase: () => Promise<void>
}

export interface Hold {
  /** Let the native download proceed. Calls suggest() exactly once; no-op after commit or a prior release. */
  release: () => void
  /**
   * Commit the takeover: cancel (must succeed) then best-effort erase.
   * Rejects after release. Starting a commit disarms the deadline timer so
   * it can never release the hold while the cancel is in flight.
   */
  cancelNative: () => Promise<void>
  released: () => boolean
  committed: () => boolean
  /** Clear the deadline timer (call from finally). */
  dispose: () => void
}

/**
 * Exactly-once release/commit state machine for a held onDeterminingFilename
 * download. Chromium tears down a suspended determination after 15s; the
 * deadline here must stay below that so a hung handoff can never race the
 * browser's own timeout into a post-suggest cancel (the zombie dialog).
 */
export function createHold(io: HoldIo, deadlineMs: number): Hold {
  let released = false
  let committed = false

  const release = (): void => {
    if (released || committed) return
    released = true
    try {
      io.suggest()
    } catch {
      // The item may already be gone (e.g. torn down by the browser).
    }
  }

  const timer = setTimeout(release, deadlineMs)

  return {
    release,
    cancelNative: async (): Promise<void> => {
      if (released) throw new Error('determination already released')
      clearTimeout(timer) // a commit is in flight: the deadline guard must not race it
      await io.cancel()
      committed = true // only after cancel succeeds: a cancel failure must fall through to release()
      try {
        await io.erase()
      } catch {
        // Best-effort history cleanup; must not abort the submit.
      }
    },
    released: () => released,
    committed: () => committed,
    dispose: () => clearTimeout(timer),
  }
}
