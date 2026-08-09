import type { WebSocketTransport } from './web-socket-transport'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string
  method: string
  params: unknown[]
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: string
  method?: string
  params?: unknown[]
  result?: unknown
  error?: { code: number; message: string }
}

interface MulticallEntry {
  methodName: string
  params: unknown[]
}

export interface JsonRpcProtocolOptions {
  timeoutMs?: number
}

export class JsonRpcProtocol {
  private nextId = 1
  private pending = new Map<string, PendingRequest>()
  private notificationHandler:
    | ((method: string, params: unknown[]) => void)
    | null = null
  private readonly timeoutMs: number

  constructor(
    private transport: WebSocketTransport,
    options: JsonRpcProtocolOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.transport.onMessage((data) => this.handleMessage(data))
  }

  call<T>(method: string, params: unknown[]): Promise<T> {
    const id = String(this.nextId++)
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(
            `JSON-RPC call "${method}" timed out after ${this.timeoutMs}ms`
          )
        )
      }, this.timeoutMs)

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })

      this.transport.send(JSON.stringify(request))
    })
  }

  multicall(
    calls: Array<{ method: string; params: unknown[] }>
  ): Promise<unknown[]> {
    // NOTE: a failed sub-call comes back as a `{code, message}` fault object
    // (not a `[value]` array), so `r[0]` silently yields `undefined` for it.
    // Acceptable for the read-only polling trio this serves; any MUTATING
    // batch must use `multicallSettled` below, which surfaces per-entry
    // faults instead of swallowing them.
    const entries: MulticallEntry[] = calls.map((c) => ({
      methodName: c.method,
      params: c.params,
    }))

    return this.call<unknown[][]>('system.multicall', [entries]).then(
      (results) => results.map((r) => r[0])
    )
  }

  /**
   * Fault-aware variant of {@link multicall}: each sub-call outcome is
   * reported independently, `Promise.allSettled`-shaped. aria2 encodes a
   * successful entry as a one-element array and a failed entry as a
   * `{code, message}` fault object; the fault becomes a rejected entry whose
   * reason carries the same `new Error(message)` shape as a single call's
   * rejection, so downstream classifiers (e.g. isNotFoundError) work
   * unchanged. Entries execute in array order on the engine side. A
   * transport-level failure still rejects the whole batch.
   */
  multicallSettled(
    calls: Array<{ method: string; params: unknown[] }>
  ): Promise<PromiseSettledResult<unknown>[]> {
    const entries: MulticallEntry[] = calls.map((c) => ({
      methodName: c.method,
      params: c.params,
    }))

    return this.call<Array<unknown[] | { code: number; message: string }>>(
      'system.multicall',
      [entries]
    ).then((results) =>
      results.map((r) =>
        Array.isArray(r)
          ? ({ status: 'fulfilled', value: r[0] } as const)
          : ({ status: 'rejected', reason: new Error(r.message) } as const)
      )
    )
  }

  onNotification(handler: (method: string, params: unknown[]) => void): void {
    this.notificationHandler = handler
  }

  private handleMessage(data: string): void {
    let msg: JsonRpcResponse
    try {
      msg = JSON.parse(data) as JsonRpcResponse
    } catch {
      return
    }

    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id)
      if (!pending) return

      clearTimeout(pending.timer)
      this.pending.delete(msg.id)

      if (msg.error) {
        pending.reject(new Error(msg.error.message))
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    if (msg.method) {
      this.notificationHandler?.(msg.method, (msg.params as unknown[]) ?? [])
    }
  }
}
