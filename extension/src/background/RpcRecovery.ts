import type { MdxpConnection, MdxpRequestMap } from '@motrix/mdxp'
import { Methods, SystemPingResultSchema } from '@motrix/mdxp'
import {
  CancellationTokenSource,
  ConnectionError,
  ErrorCodes as JsonRpcErrorCodes,
  ResponseError,
} from 'vscode-jsonrpc'
import type { RpcStatus } from '@/shared/integration'

export interface RpcSession {
  conn: MdxpConnection
  generation: number
}

const READ_METHODS = new Set<string>([
  Methods.DownloadDirectories,
  Methods.TaskList,
  Methods.TaskGet,
  Methods.StatsGet,
  Methods.EngineStatus,
])

const TRANSPORT_ERRORS = new Set<number>([
  JsonRpcErrorCodes.MessageWriteError,
  JsonRpcErrorCodes.MessageReadError,
  JsonRpcErrorCodes.PendingResponseRejected,
  JsonRpcErrorCodes.ConnectionInactive,
])

function isTransportError(error: unknown): boolean {
  return (
    error instanceof ConnectionError ||
    (error instanceof ResponseError && TRANSPORT_ERRORS.has(error.code))
  )
}

/** Rejected before sendRequest; callers may safely offer a retry/fallback. */
export class RpcNotReadyError extends Error {
  override readonly name = 'RpcNotReadyError'
}

export class RpcTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number
  ) {
    super(`${method} timed out after ${timeoutMs}ms`)
    this.name = 'RpcTimeoutError'
  }
}

export async function rpcDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  method: string,
  onTimeout?: () => void
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            reject(new RpcTimeoutError(method, timeoutMs))
            try {
              onTimeout?.()
            } catch {
              /* Cancellation is best effort. */
            }
          },
          Math.max(0, timeoutMs)
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

interface RecoveryDeps {
  session(): RpcSession | null
  reconnect(session: RpcSession, timeoutMs: number): Promise<RpcSession>
  requestTimeoutMs: number
  probeTimeoutMs?: number
  reconnectTimeoutMs?: number
  retryTimeoutMs?: number
  totalTimeoutMs?: number
}

/** One bounded recovery shared by concurrent callers. Only explicitly listed
 * reads can be replayed; a timed-out write always retains its unknown outcome. */
export class RpcRecovery {
  private epoch = 0
  private flight: Promise<RpcSession> | null = null
  private probe: { session: RpcSession; closed: boolean } | null = null
  private recoveryByConnection = new WeakMap<
    MdxpConnection,
    Promise<RpcSession>
  >()
  private active = new Map<MdxpConnection, number>()
  private blocked = false
  private retries = 0
  private idleWaiters = new Set<() => void>()
  private status: RpcStatus = {
    health: 'healthy',
    lastError: null,
    lastSuccessAt: null,
  }

  constructor(private readonly deps: RecoveryDeps) {}

  snapshot(): RpcStatus {
    return {
      ...this.status,
      health: this.flight || this.retries > 0 ? 'checking' : this.status.health,
    }
  }

  reset(): void {
    this.epoch += 1
    this.flight = null
    this.probe = null
    this.recoveryByConnection = new WeakMap()
    this.active.clear()
    this.retries = 0
    this.blocked = false
    this.status = { health: 'healthy', lastError: null, lastSuccessAt: null }
    this.notifyIdle()
  }

  isRecovering(): boolean {
    return this.flight !== null || this.retries > 0
  }

  /** The probe owns its source socket until it chooses the one reconnect.
   * Retiring that generation in the close listener would cancel recovery. */
  onSocketClosed(session: RpcSession): boolean {
    if (
      this.probe?.session.conn !== session.conn ||
      this.probe.session.generation !== session.generation
    )
      return false
    this.probe.closed = true
    return true
  }

  async ready(deadlineAt: number): Promise<void> {
    const epoch = this.epoch
    let release: (() => void) | undefined
    try {
      if (this.isRecovering())
        await rpcDeadline(
          new Promise<void>((resolve) => {
            release = resolve
            this.idleWaiters.add(resolve)
          }),
          deadlineAt - Date.now(),
          'connection recovery'
        )
    } finally {
      if (release) this.idleWaiters.delete(release)
    }
    if (epoch !== this.epoch || this.blocked)
      throw new Error('Motrix connection needs retry')
  }

  private notifyIdle(): void {
    if (this.isRecovering()) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }

  private current(session: RpcSession): boolean {
    const current = this.deps.session()
    return (
      current?.conn === session.conn &&
      current.generation === session.generation
    )
  }

  private assertCurrent(session: RpcSession, epoch: number): void {
    if (epoch !== this.epoch || !this.current(session))
      throw new Error('RPC session changed')
  }

  private async send<M extends keyof MdxpRequestMap>(
    session: RpcSession,
    method: M,
    params: MdxpRequestMap[M][0],
    timeoutMs: number
  ): Promise<MdxpRequestMap[M][1]> {
    if (timeoutMs <= 0) throw new RpcTimeoutError(method, 0)
    const cancel = READ_METHODS.has(method)
      ? new CancellationTokenSource()
      : null
    try {
      return await rpcDeadline(
        cancel
          ? session.conn.sendRequest(method, params, cancel.token)
          : session.conn.sendRequest(method, params),
        timeoutMs,
        method,
        () => cancel?.cancel()
      )
    } finally {
      cancel?.dispose()
    }
  }

  private recover(
    session: RpcSession,
    epoch: number,
    deadlineAt: number
  ): Promise<RpcSession> {
    const existing = this.recoveryByConnection.get(session.conn)
    if (existing) return existing
    this.assertCurrent(session, epoch)
    const work = (async () => {
      const sentAt = Date.now()
      let alive = false
      const probe = { session, closed: false }
      this.probe = probe
      try {
        const pong = SystemPingResultSchema.parse(
          await this.send(
            session,
            Methods.SystemPing,
            { sentAt },
            Math.min(this.deps.probeTimeoutMs ?? 2000, deadlineAt - Date.now())
          )
        )
        alive = pong.sentAt === sentAt && !probe.closed
      } catch {
        /* A failed probe retires this session, never a newer one. */
      } finally {
        if (this.probe === probe) this.probe = null
      }
      this.assertCurrent(session, epoch)
      const ready = alive
        ? session
        : await this.deps.reconnect(
            session,
            Math.min(
              this.deps.reconnectTimeoutMs ?? 8000,
              deadlineAt - Date.now()
            )
          )
      this.assertCurrent(ready, epoch)
      return ready
    })()
    this.flight = work
    this.recoveryByConnection.set(session.conn, work)
    void work.then(
      () => {
        if (epoch === this.epoch && this.flight === work) {
          this.flight = null
          // The write's outcome remains unknown to its caller, independently
          // of the transport being healthy again.
          if (
            this.status.lastError &&
            !READ_METHODS.has(this.status.lastError.method)
          )
            this.status.lastError = null
          this.notifyIdle()
        }
      },
      () => {
        if (epoch === this.epoch && this.flight === work) {
          this.flight = null
          this.blocked = true
          this.status.health = 'unresponsive'
          this.notifyIdle()
        }
      }
    )
    return work
  }

  async request<M extends keyof MdxpRequestMap>(
    method: M,
    params: MdxpRequestMap[M][0]
  ): Promise<MdxpRequestMap[M][1]> {
    const epoch = this.epoch
    const startedAt = Date.now()
    const deadlineAt = startedAt + (this.deps.totalTimeoutMs ?? 30_000)
    if (this.blocked)
      throw new RpcNotReadyError('Motrix connection needs retry')
    if (this.isRecovering() && !READ_METHODS.has(method))
      throw new RpcNotReadyError('Motrix connection is recovering')
    if (this.flight) {
      await rpcDeadline(
        this.flight,
        deadlineAt - Date.now(),
        'connection recovery'
      )
    }
    const session = this.deps.session()
    if (!session || epoch !== this.epoch)
      throw new Error('bridge not connected')
    if (!this.active.has(session.conn) && !this.status.lastError)
      this.recoveryByConnection.delete(session.conn)
    this.active.set(session.conn, (this.active.get(session.conn) ?? 0) + 1)
    try {
      try {
        const result = await this.send(
          session,
          method,
          params,
          Math.min(this.deps.requestTimeoutMs, deadlineAt - Date.now())
        )
        this.assertCurrent(session, epoch)
        this.succeeded(method)
        return result
      } catch (error) {
        if (
          (!(error instanceof RpcTimeoutError) && !isTransportError(error)) ||
          epoch !== this.epoch
        )
          throw error
        // Concurrent requests may time out after recovery has replaced their
        // connection. They must join its recorded recovery, not start another.
        if (
          !this.current(session) &&
          !this.recoveryByConnection.has(session.conn)
        )
          throw error
        this.status.lastError = {
          method,
          at: Date.now(),
          elapsedMs: Date.now() - startedAt,
          generation: session.generation,
        }
        const recovery = this.recover(session, epoch, deadlineAt)
        if (!READ_METHODS.has(method)) {
          void recovery.catch(() => {})
          throw error
        }
        this.retries += 1
        let retrySession: RpcSession | null = null
        try {
          const ready = await rpcDeadline(
            recovery,
            deadlineAt - Date.now(),
            'connection recovery'
          )
          this.assertCurrent(ready, epoch)
          retrySession = ready
          const result = await this.send(
            ready,
            method,
            params,
            Math.min(this.deps.retryTimeoutMs ?? 5000, deadlineAt - Date.now())
          )
          this.assertCurrent(ready, epoch)
          this.succeeded(method)
          return result
        } catch (retryError) {
          if (epoch === this.epoch) {
            if (
              retryError instanceof ResponseError &&
              !isTransportError(retryError) &&
              retrySession !== null &&
              this.current(retrySession)
            ) {
              // An application rejection is still an answer from the peer.
              // Surface it to this caller without labelling the socket dead.
              this.succeeded(method)
            } else {
              this.blocked = true
              this.status.health = 'unresponsive'
            }
          }
          throw retryError
        } finally {
          if (epoch === this.epoch) {
            this.retries -= 1
            this.notifyIdle()
          }
        }
      }
    } finally {
      if (epoch === this.epoch) {
        const remaining = (this.active.get(session.conn) ?? 1) - 1
        if (remaining > 0) this.active.set(session.conn, remaining)
        else this.active.delete(session.conn)
      }
    }
  }

  private succeeded(method: string): void {
    this.status.lastSuccessAt = Date.now()
    if (this.status.lastError?.method === method) this.status.lastError = null
    if (!this.blocked) this.status.health = 'healthy'
  }
}
