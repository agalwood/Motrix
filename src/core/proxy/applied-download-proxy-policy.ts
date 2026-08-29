import type { Aria2ProxyOptions } from './serializers'

/**
 * The download route known to be active in aria2.
 *
 * `null` is deliberately distinct from a direct route: it means the engine's
 * effective policy is unknown, so optional metadata requests and resumability
 * validation must fail closed. A direct route is represented by
 * `{ noProxy: '' }`, matching the empty global options sent to aria2.
 */
export type AppliedDownloadProxySnapshot = Readonly<{
  proxy?: string
  noProxy: string
}> | null

export type DownloadProxyApplyOutcome = 'applied' | 'unchanged' | 'unavailable'

export type DownloadProxyApplyResult =
  | Readonly<{
      downloadProxy: 'applied'
      /** Exact endpoint/no-proxy pair passed to aria2; null means direct. */
      appliedProxy: Aria2ProxyOptions | null
    }>
  | Readonly<{
      downloadProxy: Exclude<DownloadProxyApplyOutcome, 'applied'>
    }>

export interface AppliedDownloadProxyPolicyReader {
  snapshot(): AppliedDownloadProxySnapshot
  runWithSnapshot<T>(
    operation: (
      snapshot: AppliedDownloadProxySnapshot,
      lease: AppliedDownloadProxyLease
    ) => Promise<T>
  ): Promise<T>
}

export interface AppliedDownloadProxyLease {
  /** Abort before engine dispatch if restart invalidated this snapshot. */
  assertCurrent(): void
}

export interface AppliedDownloadProxyTransitionContext {
  /** The route was already unknown before this transition acquired its lock. */
  wasUnavailable: boolean
}

export class AppliedDownloadProxyPolicyChangedError extends Error {
  constructor() {
    super('applied download proxy policy changed during task admission')
    this.name = 'AppliedDownloadProxyPolicyChangedError'
  }
}

/** Fail-closed sentinel for optional outer composition seams and tests. */
export const UNAVAILABLE_APPLIED_DOWNLOAD_PROXY_POLICY: AppliedDownloadProxyPolicyReader =
  Object.freeze({
    snapshot: () => null,
    runWithSnapshot: <T>(
      operation: (
        snapshot: AppliedDownloadProxySnapshot,
        lease: AppliedDownloadProxyLease
      ) => Promise<T>
    ) => operation(null, { assertCurrent: () => undefined }),
  })

type LockWaiter = {
  mode: 'read' | 'write'
  resolve: (release: () => void) => void
}

/**
 * In-memory coordination between aria2 proxy changes and short-lived resource
 * requests. Nothing in this object is serialized or attached to task records.
 */
export class AppliedDownloadProxyPolicy
  implements AppliedDownloadProxyPolicyReader
{
  private current: AppliedDownloadProxySnapshot
  private generation = 0
  private activeReaders = 0
  private writerActive = false
  private readonly waiters: LockWaiter[] = []

  constructor(initial: AppliedDownloadProxySnapshot = null) {
    this.current = cloneSnapshot(initial)
  }

  snapshot(): AppliedDownloadProxySnapshot {
    return cloneSnapshot(this.current)
  }

  /** Called when the engine starts/restarts with its exact resolved route. */
  commit(resolvedProxy: Aria2ProxyOptions | null): void {
    // Startup must be able to publish the route before Ready even when a
    // fail-closed reader is waiting for Ready. Existing readers are fenced by
    // their generation lease and must assert it immediately before dispatch.
    this.current = snapshotFromResolvedProxy(resolvedProxy)
    this.generation++
  }

  /** Unknown engine state is never equivalent to a confirmed direct route. */
  markUnavailable(): void {
    this.current = null
    this.generation++
  }

  async runWithSnapshot<T>(
    operation: (
      snapshot: AppliedDownloadProxySnapshot,
      lease: AppliedDownloadProxyLease
    ) => Promise<T>
  ): Promise<T> {
    const release = await this.acquire('read')
    const generation = this.generation
    try {
      return await operation(this.snapshot(), {
        assertCurrent: () => {
          if (this.generation !== generation) {
            throw new AppliedDownloadProxyPolicyChangedError()
          }
        },
      })
    } finally {
      release()
    }
  }

  /**
   * Serialize a settings transition against metadata validation and engine
   * dispatch. Readers are held while the engine route is changing. On a thrown
   * or explicitly unavailable application, queued readers observe `null` and
   * fail closed. An unrelated proxy-scope change restores the prior snapshot.
   */
  async applyTransition<T extends DownloadProxyApplyResult>(
    operation: (context: AppliedDownloadProxyTransitionContext) => Promise<T>
  ): Promise<T> {
    const release = await this.acquire('write')
    const previous = this.current
    this.current = null
    this.generation++
    const transitionGeneration = this.generation
    try {
      const result = await operation({ wasUnavailable: previous === null })
      if (this.generation !== transitionGeneration) {
        // A startup/restart committed while the hot apply was in flight. The
        // relative order of its route and the RPC result is not provable.
        this.current = null
      } else if (result.downloadProxy === 'applied') {
        this.current = snapshotFromResolvedProxy(result.appliedProxy)
      } else if (result.downloadProxy === 'unchanged') {
        this.current = previous
      } else {
        this.current = null
      }
      this.generation++
      return result
    } catch (error) {
      // The bridge and aria2 may now disagree after a partial failure. Keeping
      // either old or new credentials would claim knowledge we do not have.
      this.current = null
      this.generation++
      throw error
    } finally {
      release()
    }
  }

  /**
   * Publish the route selected at the end of engine startup and Ready as one
   * writer transaction. Settings updates can be persisted while aria2 is
   * Starting, but their proxy transition then queues behind this writer (or
   * runs before it). In either order, `resolveRoute` re-reads the latest
   * settings and no observer can see Ready with a stale route snapshot.
   */
  async publishStartupRoute(
    resolveRoute: () => Promise<Aria2ProxyOptions | null>,
    publishReady: () => void,
    shouldPublish: () => boolean = () => true
  ): Promise<boolean> {
    const release = await this.acquire('write')
    this.current = null
    this.generation++
    try {
      const resolvedProxy = await resolveRoute()
      if (!shouldPublish()) return false
      this.current = snapshotFromResolvedProxy(resolvedProxy)
      this.generation++
      publishReady()
      return true
    } catch (error) {
      this.current = null
      this.generation++
      throw error
    } finally {
      release()
    }
  }

  private acquire(mode: LockWaiter['mode']): Promise<() => void> {
    if (this.canAcquireImmediately(mode)) {
      return Promise.resolve(this.activate(mode))
    }
    return new Promise((resolve) => {
      this.waiters.push({ mode, resolve })
    })
  }

  private canAcquireImmediately(mode: LockWaiter['mode']): boolean {
    if (this.writerActive) return false
    if (mode === 'write') return this.activeReaders === 0
    // Once a writer queues, later readers wait behind it so settings changes
    // cannot starve under a stream of concurrent task submissions.
    return !this.waiters.some((waiter) => waiter.mode === 'write')
  }

  private activate(mode: LockWaiter['mode']): () => void {
    let released = false
    if (mode === 'write') this.writerActive = true
    else this.activeReaders++
    return () => {
      if (released) return
      released = true
      if (mode === 'write') this.writerActive = false
      else this.activeReaders--
      this.drain()
    }
  }

  private drain(): void {
    if (
      this.writerActive ||
      this.activeReaders > 0 ||
      this.waiters.length === 0
    ) {
      return
    }

    if (this.waiters[0]?.mode === 'write') {
      const waiter = this.waiters.shift()
      waiter?.resolve(this.activate('write'))
      return
    }

    while (this.waiters[0]?.mode === 'read') {
      const waiter = this.waiters.shift()
      waiter?.resolve(this.activate('read'))
    }
  }
}

function snapshotFromResolvedProxy(
  resolvedProxy: Aria2ProxyOptions | null
): Exclude<AppliedDownloadProxySnapshot, null> {
  return Object.freeze(
    resolvedProxy
      ? { proxy: resolvedProxy.allProxy, noProxy: resolvedProxy.noProxy }
      : { noProxy: '' }
  )
}

function cloneSnapshot(
  snapshot: AppliedDownloadProxySnapshot
): AppliedDownloadProxySnapshot {
  return snapshot ? { ...snapshot } : null
}
