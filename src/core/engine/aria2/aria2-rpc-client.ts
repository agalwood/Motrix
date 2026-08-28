import type { JsonRpcProtocol } from './json-rpc-protocol'
import type {
  Aria2HistoryCount,
  Aria2HistoryFilter,
  Aria2MethodCall,
  Aria2RawFile,
  Aria2RawGlobalStat,
  Aria2RawPeer,
  Aria2RawStatus,
  Aria2RawUri,
  Aria2RequeueResult,
  Aria2SearchQuery,
  Aria2Version,
} from './types'
import type { WebSocketTransport } from './web-socket-transport'

interface Aria2Event {
  gid: string
}

type EventHandler = (event: Aria2Event) => void
type Unsubscribe = () => void

// Methods that do NOT require secret injection
const SECRET_EXEMPT_METHODS = new Set([
  'system.listMethods',
  'system.listNotifications',
])

export class Aria2RpcClient {
  private notificationHandlers = new Map<string, Set<EventHandler>>()

  constructor(
    private transport: WebSocketTransport,
    private protocol: JsonRpcProtocol,
    private secret: string
  ) {
    this.protocol.onNotification((method, params) => {
      this.handleNotification(method, params as unknown[])
    })
  }

  // ─── Connection ──────────────────────────────────────────────

  async connect(port: number, retries = 10, delayMs = 500): Promise<void> {
    const url = `ws://127.0.0.1:${port}/jsonrpc`
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        await this.transport.connect(url)
        return
      } catch (err) {
        if (attempt === retries - 1) throw err
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
  }

  disconnect(): void {
    this.transport.disconnect()
  }

  isConnected(): boolean {
    return this.transport.isConnected()
  }

  // ─── Secret injection ────────────────────────────────────────

  /** Synchronize the credential used for all subsequent RPC calls. */
  setSecret(secret: string): void {
    this.secret = secret
  }

  private withSecret(params: unknown[]): unknown[] {
    return this.secret === '' ? params : [`token:${this.secret}`, ...params]
  }

  private call<T>(method: string, params: unknown[]): Promise<T> {
    const finalParams = SECRET_EXEMPT_METHODS.has(method)
      ? params
      : this.withSecret(params)
    return this.protocol.call<T>(method, finalParams)
  }

  // ─── Download management ─────────────────────────────────────

  addUri(
    uris: string[],
    options?: Record<string, string | string[]>,
    position?: number
  ): Promise<string> {
    const params: unknown[] = [uris]
    if (options !== undefined) params.push(options)
    if (position !== undefined) params.push(position)
    return this.call<string>('aria2.addUri', params)
  }

  addTorrent(
    torrentBase64: string,
    uris?: string[],
    options?: Record<string, string | string[]>
  ): Promise<string> {
    const params: unknown[] = [torrentBase64]
    if (uris !== undefined) params.push(uris)
    if (options !== undefined) params.push(options)
    return this.call<string>('aria2.addTorrent', params)
  }

  addMetalink(
    metalinkBase64: string,
    options?: Record<string, string>
  ): Promise<string[]> {
    const params: unknown[] = [metalinkBase64]
    if (options !== undefined) params.push(options)
    return this.call<string[]>('aria2.addMetalink', params)
  }

  // ─── Task control ────────────────────────────────────────────

  remove(gid: string): Promise<string> {
    return this.call<string>('aria2.remove', [gid])
  }

  forceRemove(gid: string): Promise<string> {
    return this.call<string>('aria2.forceRemove', [gid])
  }

  pause(gid: string): Promise<string> {
    return this.call<string>('aria2.pause', [gid])
  }

  forcePause(gid: string): Promise<string> {
    return this.call<string>('aria2.forcePause', [gid])
  }

  unpause(gid: string): Promise<string> {
    return this.call<string>('aria2.unpause', [gid])
  }

  pauseAll(): Promise<'OK'> {
    return this.call<'OK'>('aria2.pauseAll', [])
  }

  unpauseAll(): Promise<'OK'> {
    return this.call<'OK'>('aria2.unpauseAll', [])
  }

  removeDownloadResult(gid: string): Promise<'OK'> {
    return this.call<'OK'>('aria2.removeDownloadResult', [gid])
  }

  changePosition(
    gid: string,
    pos: number,
    how: 'POS_SET' | 'POS_CUR' | 'POS_END'
  ): Promise<number> {
    return this.call<number>('aria2.changePosition', [gid, pos, how])
  }

  // ─── Status queries ──────────────────────────────────────────

  tellStatus(gid: string, keys?: string[]): Promise<Aria2RawStatus> {
    const params: unknown[] = [gid]
    if (keys !== undefined) params.push(keys)
    return this.call<Aria2RawStatus>('aria2.tellStatus', params)
  }

  tellActive(keys?: string[]): Promise<Aria2RawStatus[]> {
    const params: unknown[] = []
    if (keys !== undefined) params.push(keys)
    return this.call<Aria2RawStatus[]>('aria2.tellActive', params)
  }

  tellWaiting(
    offset: number,
    num: number,
    keys?: string[]
  ): Promise<Aria2RawStatus[]> {
    const params: unknown[] = [offset, num]
    if (keys !== undefined) params.push(keys)
    return this.call<Aria2RawStatus[]>('aria2.tellWaiting', params)
  }

  tellStopped(
    offset: number,
    num: number,
    keys?: string[]
  ): Promise<Aria2RawStatus[]> {
    const params: unknown[] = [offset, num]
    if (keys !== undefined) params.push(keys)
    return this.call<Aria2RawStatus[]>('aria2.tellStopped', params)
  }

  getFiles(gid: string): Promise<Aria2RawFile[]> {
    return this.call<Aria2RawFile[]>('aria2.getFiles', [gid])
  }

  getUris(gid: string): Promise<Aria2RawUri[]> {
    return this.call<Aria2RawUri[]>('aria2.getUris', [gid])
  }

  getPeers(gid: string): Promise<Aria2RawPeer[]> {
    return this.call<Aria2RawPeer[]>('aria2.getPeers', [gid])
  }

  // ─── Global ──────────────────────────────────────────────────

  getGlobalStat(): Promise<Aria2RawGlobalStat> {
    return this.call<Aria2RawGlobalStat>('aria2.getGlobalStat', [])
  }

  getGlobalOption(): Promise<Record<string, string>> {
    return this.call<Record<string, string>>('aria2.getGlobalOption', [])
  }

  changeGlobalOption(options: Record<string, string>): Promise<'OK'> {
    return this.call<'OK'>('aria2.changeGlobalOption', [options])
  }

  getOption(gid: string): Promise<Record<string, string>> {
    return this.call<Record<string, string>>('aria2.getOption', [gid])
  }

  changeOption(gid: string, options: Record<string, string>): Promise<'OK'> {
    return this.call<'OK'>('aria2.changeOption', [gid, options])
  }

  // ─── System ──────────────────────────────────────────────────

  getVersion(): Promise<Aria2Version> {
    return this.call<Aria2Version>('aria2.getVersion', [])
  }

  getSessionInfo(): Promise<{ sessionId: string }> {
    return this.call<{ sessionId: string }>('aria2.getSessionInfo', [])
  }

  shutdown(): Promise<'OK'> {
    return this.call<'OK'>('aria2.shutdown', [])
  }

  forceShutdown(): Promise<'OK'> {
    return this.call<'OK'>('aria2.forceShutdown', [])
  }

  saveSession(): Promise<'OK'> {
    return this.call<'OK'>('aria2.saveSession', [])
  }

  listMethods(): Promise<string[]> {
    return this.call<string[]>('system.listMethods', [])
  }

  listNotifications(): Promise<string[]> {
    return this.call<string[]>('system.listNotifications', [])
  }

  // ─── Batch (performance) ─────────────────────────────────────

  multicall(calls: Aria2MethodCall[]): Promise<unknown[]> {
    // Each sub-call needs the same secret-injection treatment as a
    // single `call()`. Without it aria2 returns `{faultCode:1,
    // faultString:"Unauthorized"}` for every entry; the protocol
    // layer's `r[0]` extraction then yields `undefined`, which
    // silently corrupts every downstream consumer (most visibly
    // PollingScheduler). See spec 2026-04-25-engine-config-design.
    const withSecret = calls.map((c) => ({
      method: c.method,
      params: SECRET_EXEMPT_METHODS.has(c.method)
        ? c.params
        : this.withSecret(c.params),
    }))
    return this.protocol.multicall(withSecret)
  }

  /**
   * Fault-aware batch: same per-entry secret injection as {@link multicall},
   * but per-entry outcomes survive (see JsonRpcProtocol.multicallSettled).
   * Required for any batch of MUTATING calls, where a swallowed fault would
   * silently corrupt caller bookkeeping.
   */
  multicallSettled(
    calls: Aria2MethodCall[]
  ): Promise<PromiseSettledResult<unknown>[]> {
    const withSecret = calls.map((c) => ({
      method: c.method,
      params: SECRET_EXEMPT_METHODS.has(c.method)
        ? c.params
        : this.withSecret(c.params),
    }))
    return this.protocol.multicallSettled(withSecret)
  }

  // ─── SQLite3-Persistence RPCs (aria2_motrix fork) ────────────
  //
  // Each call requires `--enable-sqlite3-persistence=true` on the engine.
  // When disabled, the fork raises "SQLite3 persistence is not enabled".
  // Adapters MUST gate UI on EngineFeatureReport.hasSqlitePersistence
  // before calling these.

  getDownloadResultCount(
    filter?: Aria2HistoryFilter
  ): Promise<Aria2HistoryCount> {
    const params: unknown[] = []
    if (filter !== undefined) params.push(filter)
    return this.call<Aria2HistoryCount>('aria2.getDownloadResultCount', params)
  }

  searchDownloadResult(
    query: Aria2SearchQuery,
    offset: number,
    num: number,
    keys?: string[]
  ): Promise<Aria2RawStatus[]> {
    const params: unknown[] = [query, offset, num]
    if (keys !== undefined) params.push(keys)
    return this.call<Aria2RawStatus[]>('aria2.searchDownloadResult', params)
  }

  exportSession(filePath: string): Promise<'OK'> {
    return this.call<'OK'>('aria2.exportSession', [filePath])
  }

  requeueDownloadResult(
    gid: string,
    options?: Record<string, string>
  ): Promise<Aria2RequeueResult> {
    const params: unknown[] = [gid]
    if (options !== undefined) params.push(options)
    return this.call<Aria2RequeueResult>('aria2.requeueDownloadResult', params)
  }

  // ─── Event subscriptions (WebSocket push) ────────────────────

  onDownloadStart(handler: EventHandler): Unsubscribe {
    return this.addHandler('aria2.onDownloadStart', handler)
  }

  onDownloadPause(handler: EventHandler): Unsubscribe {
    return this.addHandler('aria2.onDownloadPause', handler)
  }

  onDownloadStop(handler: EventHandler): Unsubscribe {
    return this.addHandler('aria2.onDownloadStop', handler)
  }

  onDownloadComplete(handler: EventHandler): Unsubscribe {
    return this.addHandler('aria2.onDownloadComplete', handler)
  }

  onDownloadError(handler: EventHandler): Unsubscribe {
    return this.addHandler('aria2.onDownloadError', handler)
  }

  onBtDownloadComplete(handler: EventHandler): Unsubscribe {
    return this.addHandler('aria2.onBtDownloadComplete', handler)
  }

  // ─── Internal ────────────────────────────────────────────────

  private addHandler(method: string, handler: EventHandler): Unsubscribe {
    if (!this.notificationHandlers.has(method)) {
      this.notificationHandlers.set(method, new Set())
    }
    const handlers = this.notificationHandlers.get(method)
    handlers?.add(handler)
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      handlers?.delete(handler)
      if (handlers?.size === 0) {
        this.notificationHandlers.delete(method)
      }
    }
  }

  private handleNotification(method: string, params: unknown[]): void {
    const handlers = this.notificationHandlers.get(method)
    if (handlers && params.length > 0) {
      const event = params[0] as Aria2Event
      for (const handler of [...handlers]) {
        handler(event)
      }
    }
  }
}
