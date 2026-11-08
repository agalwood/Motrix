import { MAX_TORRENT_RPC_BODY_LIMIT_BYTES } from '@shared/lib/torrent-meta'
import type { WebSocketTransport } from './web-socket-transport'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
  uncorrelatedError?: Error
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string
  method: string
  params: unknown[]
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: string | null
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
  maxRequestBytes?: number
}

export interface JsonRpcCallOptions {
  timeoutMs?: number
}

export class JsonRpcRequestTooLargeError extends Error {
  constructor(method: string, requestBytes: number, maxRequestBytes: number) {
    super(
      `JSON-RPC request "${method}" is ${requestBytes} bytes, exceeding the configured ${maxRequestBytes}-byte limit (including metadata and options)`
    )
    this.name = 'JsonRpcRequestTooLargeError'
  }
}

export class JsonRpcProtocol {
  private nextId = 1
  private pending = new Map<string, PendingRequest>()
  private notificationHandler:
    | ((method: string, params: unknown[]) => void)
    | null = null
  private readonly timeoutMs: number
  private readonly maxRequestBytes: number

  constructor(
    private transport: WebSocketTransport,
    options: JsonRpcProtocolOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.maxRequestBytes =
      options.maxRequestBytes ?? MAX_TORRENT_RPC_BODY_LIMIT_BYTES
    if (
      !Number.isSafeInteger(this.maxRequestBytes) ||
      this.maxRequestBytes <= 0
    ) {
      throw new TypeError('maxRequestBytes must be a positive safe integer')
    }
    this.transport.onMessage((data) => this.handleMessage(data))
  }

  call<T>(
    method: string,
    params: unknown[],
    options: JsonRpcCallOptions = {}
  ): Promise<T> {
    const id = String(this.nextId++)
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }

    return new Promise<T>((resolve, reject) => {
      // Measure the exact UTF-8 envelope, including tokens, index-out and
      // select-file. A Base64-only check misses large multi-file requests.
      const serialized = JSON.stringify(request)
      const requestBytes = Buffer.byteLength(serialized, 'utf8')
      if (requestBytes > this.maxRequestBytes) {
        reject(
          new JsonRpcRequestTooLargeError(
            method,
            requestBytes,
            this.maxRequestBytes
          )
        )
        return
      }
      const timeoutMs = options.timeoutMs ?? this.timeoutMs
      const timer = setTimeout(() => {
        const diagnostic = this.pending.get(id)?.uncorrelatedError
        this.pending.delete(id)
        reject(
          new Error(
            diagnostic
              ? `No matching JSON-RPC response for "${method}" after ${timeoutMs}ms; ${diagnostic.message}; request outcome is unknown`
              : `JSON-RPC call "${method}" timed out after ${timeoutMs}ms`
          )
        )
      }, timeoutMs)

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })

      try {
        this.transport.send(serialized)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
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

    if (msg.id === null && msg.error) {
      const error = new Error(
        `JSON-RPC peer reported ${msg.error.code}: ${msg.error.message} without a request id`
      )
      const single =
        this.pending.size === 1
          ? this.pending.entries().next().value
          : undefined
      if (single) {
        const [id, pending] = single
        clearTimeout(pending.timer)
        this.pending.delete(id)
        pending.reject(error)
      } else {
        // Do not guess which concurrent mutation failed or reject successful
        // unrelated calls. Preserve the peer's diagnostic for unresolved calls.
        for (const pending of this.pending.values())
          pending.uncorrelatedError = error
      }
      return
    }

    if (typeof msg.id === 'string') {
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
