import { access } from 'node:fs/promises'
import path from 'node:path'
import { getLogger } from '@core/logger'
import {
  extractAria2ProxyCredentials,
  normalizeAria2TaskProxyUrl,
  stripAria2ProxyCredentials,
} from '@core/proxy/aria2-proxy-routing'
import { AppError, ErrorCode } from '@shared/errors'
import type {
  EngineCapability,
  EngineFeatureReport,
} from '@shared/types/engine'
import type { EngineTaskOptions } from '@shared/types/engine-task-options'
import type {
  HistoryFilter,
  HistorySearchQuery,
  RequeueResult,
} from '@shared/types/history'
import type { TaskPeer } from '@shared/types/peer'
import type { TaskPiecesResult } from '@shared/types/pieces'
import type { GlobalStats } from '@shared/types/stats'
import type { DownloadTask, TaskFile } from '@shared/types/task'
import type { TuningContext } from '@shared/types/tuning'
import { probeQuick } from '../../probe/disk-probe'
import type {
  AddTorrentParams,
  CreateDownloadParams,
  DirectResourceMetadataProfile,
  EngineAdapter,
} from '../engine-adapter'
import { DIRECT_RESOURCE_METADATA_PROFILE } from '../engine-adapter'
import type { Aria2RpcClient } from './aria2-rpc-client'
import { recommend } from './aria2-tuning'
import { isConnectionLimitRangeError, isNotFoundError } from './error-utils'

/**
 * Per-multicall cap for removeDownloadResults. One unbounded batch must
 * complete inside JsonRpcProtocol's fixed request timeout, which a large
 * stopped-history cannot; bounded chunks keep each round-trip small and let
 * cleanup make progress across retries. The history can far exceed aria2's
 * in-memory window (--max-download-result, default 1000) because the fork's
 * sqlite3 persistence keeps every evicted row (--sqlite3-history-limit
 * defaults to unlimited) and merges them into tellStopped.
 */
const REMOVE_RESULT_CHUNK_SIZE = 100
const RESERVED_TASK_PROXY_OPTIONS = new Set([
  'all-proxy',
  'all-proxy-user',
  'all-proxy-passwd',
  'http-proxy',
  'http-proxy-user',
  'http-proxy-passwd',
  'https-proxy',
  'https-proxy-user',
  'https-proxy-passwd',
  'ftp-proxy',
  'ftp-proxy-user',
  'ftp-proxy-passwd',
  'no-proxy',
  'proxy-method',
])

type FileAccess = (filePath: string) => Promise<void>

const AMBIENT_HTTP_TEXT_OPTIONS = [
  'referer',
  'load-cookies',
  'http-user',
  'http-passwd',
] as const

const AMBIENT_HTTP_TRUE_OPTIONS = [
  'conditional-get',
  'dry-run',
  'http-auth-challenge',
  'http-no-cache',
  'use-head',
] as const

/**
 * Convert aria2's effective global options into a non-secret compatibility
 * decision. User values are never returned or logged. A configured netrc is
 * safe only when it is disabled or its effective file does not exist; a
 * present file may change Authorization and must preserve the user's behavior.
 */
export async function directResourceMetadataProfileFromGlobalOptions(
  options: Readonly<Record<string, string>>,
  accessFile: FileAccess = access
): Promise<DirectResourceMetadataProfile | null> {
  if (
    hasEffectiveCumulativeValue(options.header) ||
    AMBIENT_HTTP_TEXT_OPTIONS.some((name) => options[name]?.length > 0) ||
    AMBIENT_HTTP_TRUE_OPTIONS.some((name) => isAria2True(options[name])) ||
    options['http-accept-gzip'] !== 'true' ||
    options['no-want-digest-header'] !== 'false'
  ) {
    return null
  }

  if (!isAria2True(options['no-netrc'])) {
    const netrcPath = options['netrc-path']?.trim()
    if (!netrcPath) return null
    try {
      await accessFile(netrcPath)
      return null
    } catch (error) {
      if (!isMissingPathError(error)) return null
    }
  }

  return DIRECT_RESOURCE_METADATA_PROFILE
}

import {
  buildFeatureReport,
  hasDurableRemoveSemantics,
  isMotrixFork,
  STANDARD_ARIA2_CONNECTION_LIMIT,
} from './feature-report'
import {
  translateGlobalStat,
  translatePeer,
  translateRawFile,
  translateRawToTask,
} from './translate'

export class Aria2Adapter implements EngineAdapter {
  private readonly log = getLogger('aria2-adapter')
  private capability: EngineCapability = {
    http: true,
    ftp: true,
    bt: false,
    magnet: false,
    metalink: false,
  }
  private featureReport: EngineFeatureReport = {
    version: 'unknown',
    features: [],
    hasSqlitePersistence: false,
    hasBtSeedUnverified: false,
    hasBtSaveMetadata: false,
    hasMoveStorage: false,
  }
  private connectionOptionLimit: number | null = null
  private directResourceMetadataProfile: DirectResourceMetadataProfile | null =
    null

  private btCompleteHandlers: Array<(engineTaskId: string) => void> = []
  private downloadCompleteHandlers: Array<(engineTaskId: string) => void> = []
  private downloadErrorHandlers: Array<(engineTaskId: string) => void> = []
  private readonly rpcUnsubscribers: Array<() => void> = []
  private disposed = false

  constructor(
    private rpc: Aria2RpcClient,
    private readonly accessFile: FileAccess = access
  ) {
    const unsubscribers = [
      this.rpc.onBtDownloadComplete((event) => {
        this.fanOut(this.btCompleteHandlers, event.gid)
      }),
      this.rpc.onDownloadComplete((event) => {
        this.fanOut(this.downloadCompleteHandlers, event.gid)
      }),
      this.rpc.onDownloadError((event) => {
        this.fanOut(this.downloadErrorHandlers, event.gid)
      }),
    ]
    for (const unsubscribe of unsubscribers) {
      if (typeof unsubscribe === 'function') {
        this.rpcUnsubscribers.push(unsubscribe)
      }
    }
  }

  async inspectDirectResourceMetadataProfile(): Promise<DirectResourceMetadataProfile | null> {
    try {
      return await directResourceMetadataProfileFromGlobalOptions(
        await this.rpc.getGlobalOption(),
        this.accessFile
      )
    } catch (error) {
      // The profile is a safety proof, not a startup dependency. RPC or file
      // inspection failures disable optional probing/replay without exposing
      // the possibly secret global option values in logs.
      this.log.debug(
        { err: error },
        'aria2 HTTP metadata request profile is unavailable'
      )
      return null
    }
  }

  setDirectResourceMetadataProfile(
    profile: DirectResourceMetadataProfile | null
  ): void {
    this.directResourceMetadataProfile = profile
  }

  getDirectResourceMetadataProfile(): DirectResourceMetadataProfile | null {
    return this.directResourceMetadataProfile
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.btCompleteHandlers = []
    this.downloadCompleteHandlers = []
    this.downloadErrorHandlers = []
    let firstError: unknown
    for (const unsubscribe of this.rpcUnsubscribers.splice(0)) {
      try {
        unsubscribe()
      } catch (error) {
        firstError ??= error
      }
    }
    if (firstError !== undefined) {
      throw firstError
    }
  }

  private fanOut(
    handlers: Array<(engineTaskId: string) => void>,
    gid: string
  ): void {
    for (const h of handlers) {
      try {
        h(gid)
      } catch {
        // Isolate handler errors so one throw does not block other
        // subscribers from receiving the event.
      }
    }
  }

  async connect(): Promise<void> {
    // RPC connection lifecycle is managed by EngineSupervisor.
    // The adapter uses connect() to probe engine capabilities.
    try {
      const v = await this.rpc.getVersion()
      const features = v.enabledFeatures ?? []
      this.featureReport = buildFeatureReport(v.version, features)
      this.capability = {
        http: true,
        ftp: true,
        bt: features.includes('BitTorrent'),
        magnet: features.includes('BitTorrent'),
        metalink: features.includes('Metalink'),
      }
    } catch {
      // If the probe fails (engine not ready, RPC error), keep the
      // conservative defaults. EngineSupervisor will surface the
      // underlying connection error separately.
    }
  }

  async disconnect(): Promise<void> {
    // Disconnection is managed by EngineSupervisor.
  }

  getCapabilities(): EngineCapability {
    return this.capability
  }

  getFeatureReport(): EngineFeatureReport {
    return this.featureReport
  }

  /**
   * Inject the feature report the EngineSupervisor already probed. Production
   * never calls `connect()`, so without this the adapter would keep its
   * conservative default (version 'unknown', no persistence) and the
   * durable-remove trust gate would silently treat every engine as safe.
   */
  setFeatureReport(report: EngineFeatureReport): void {
    this.featureReport = report
    this.connectionOptionLimit = isMotrixFork(report)
      ? null
      : STANDARD_ARIA2_CONNECTION_LIMIT
  }

  private capConnectionOptions(
    options: Record<string, string | string[]>,
    limit: number
  ): Record<string, string | string[]> {
    const compatible = { ...options }
    for (const key of ['split', 'max-connection-per-server']) {
      const value = compatible[key]
      if (typeof value !== 'string') continue
      const parsed = Number.parseInt(value, 10)
      if (Number.isFinite(parsed) && parsed > limit) {
        compatible[key] = String(limit)
      }
    }
    return compatible
  }

  private async addUriWithConnectionFallback(
    uris: string[],
    options: Record<string, string | string[]>
  ): Promise<string> {
    const firstOptions =
      this.connectionOptionLimit === null
        ? options
        : this.capConnectionOptions(options, this.connectionOptionLimit)

    try {
      return await this.rpc.addUri(uris, firstOptions)
    } catch (error) {
      const fallbackOptions = this.capConnectionOptions(
        firstOptions,
        STANDARD_ARIA2_CONNECTION_LIMIT
      )
      const changed = Object.keys(fallbackOptions).some(
        (key) => fallbackOptions[key] !== firstOptions[key]
      )
      if (!changed || !isConnectionLimitRangeError(error)) throw error

      this.connectionOptionLimit = STANDARD_ARIA2_CONNECTION_LIMIT
      this.log.warn(
        { err: error },
        'aria2 rejected connection options; retrying with compatibility limit'
      )
      return this.rpc.addUri(uris, fallbackOptions)
    }
  }

  async createDownload(params: CreateDownloadParams): Promise<string> {
    const extraGid = params.extraEngineOptions?.gid
    if (extraGid !== undefined && typeof extraGid !== 'string') {
      throw new TypeError(
        'aria2 addUri gid must contain exactly 16 hexadecimal characters'
      )
    }
    const requestedGid =
      params.gid ?? (typeof extraGid === 'string' ? extraGid : undefined)
    if (requestedGid !== undefined && !/^[0-9a-fA-F]{16}$/.test(requestedGid)) {
      throw new TypeError(
        'aria2 addUri gid must contain exactly 16 hexadecimal characters'
      )
    }
    const metadataProfile = params.directResourceMetadataProfile
    if (
      metadataProfile !== undefined &&
      this.getDirectResourceMetadataProfile() !== metadataProfile
    ) {
      throw new Error(
        'aria2 HTTP request profile changed before download dispatch'
      )
    }
    const options: Record<string, string | string[]> = {
      dir: params.saveDir,
    }
    if (params.filename) options.out = params.filename
    if (params.dlLimit) {
      options['max-download-limit'] = String(params.dlLimit)
    }
    if (params.ulLimit) {
      options['max-upload-limit'] = String(params.ulLimit)
    }
    if (params.pause) {
      // Per-call override of the global --pause=false invariant. Used by
      // SessionManager to re-add a paused HTTP task after restart so the
      // engine state matches the persisted Motrix status.
      options.pause = 'true'
    }
    const requestHeaders = Object.entries(params.headers ?? {})
    if (metadataProfile === DIRECT_RESOURCE_METADATA_PROFILE) {
      // An empty custom field suppresses aria2's built-in Cookie/AuthConfig
      // values while preserving the exact field presence mirrored by Undici.
      // Explicit task values always win.
      if (!hasRequestHeader(requestHeaders, 'cookie')) {
        requestHeaders.push(['Cookie', ''])
      }
      if (!hasRequestHeader(requestHeaders, 'authorization')) {
        requestHeaders.push(['Authorization', ''])
      }
    }
    if (
      params.uris.every((uri) => /^https?:\/\//i.test(uri)) &&
      !hasRequestHeader(requestHeaders, 'accept')
    ) {
      // A Metalink-enabled aria2 expands its built-in Accept value on the
      // first HTTP request. Pin Motrix direct downloads to the exact value
      // used by metadata validation so content negotiation cannot diverge.
      requestHeaders.push(['Accept', '*/*'])
    }
    if (requestHeaders.length > 0) {
      options.header = requestHeaders.map(([key, value]) => `${key}: ${value}`)
    }
    if (params.userAgent !== undefined) {
      if (hasC0OrDel(params.userAgent)) {
        throw new TypeError(
          'Task User-Agent must not contain control characters'
        )
      }
      options['user-agent'] = params.userAgent
    }
    if (params.connections != null) {
      options.split = String(params.connections)
      options['max-connection-per-server'] = String(params.connections)
    }
    if (metadataProfile === DIRECT_RESOURCE_METADATA_PROFILE) {
      // Pin every scalar request semantic represented by the profile before
      // passthrough options. A caller that intentionally supplies an engine
      // option keeps the historical last-write-wins behavior below; such
      // calls are excluded from metadata probing by CreateTaskHandler.
      options.referer = ''
      options['http-no-cache'] = 'false'
      options['conditional-get'] = 'false'
      options['use-head'] = 'false'
      options['no-netrc'] = 'true'
      options['http-user'] = ''
      options['http-passwd'] = ''
      options['http-auth-challenge'] = 'false'
      options['http-accept-gzip'] = 'true'
      options['no-want-digest-header'] = 'false'
    }
    if (params.extraEngineOptions) {
      for (const [k, v] of Object.entries(params.extraEngineOptions)) {
        if (RESERVED_TASK_PROXY_OPTIONS.has(k.toLowerCase())) {
          throw new TypeError(`Reserved aria2 proxy option: ${k}`)
        }
        options[k] = v
      }
    }
    const taskProxy = params.proxy?.trim()
    if (taskProxy) {
      const normalizedProxy = normalizeAria2TaskProxyUrl(taskProxy)
      if (!normalizedProxy) {
        throw new TypeError(
          'Task proxy must use aria2-compatible HTTP or HTTPS syntax'
        )
      }
      const credentials = extractAria2ProxyCredentials(taskProxy)
      const proxyWithoutCredentials = stripAria2ProxyCredentials(taskProxy)
      if (!credentials || !proxyWithoutCredentials) {
        throw new TypeError('Unsupported aria2 proxy credentials')
      }
      // Reapply the complete task proxy after passthrough options. Carry
      // credentials only in aria2's dedicated fields: duplicating them in the
      // URI also makes them more likely to appear in engine state or logs.
      options['all-proxy'] = proxyWithoutCredentials
      options['all-proxy-user'] = credentials.username
      options['all-proxy-passwd'] = credentials.password
    }

    const automaticTuning =
      params.performanceProfile === undefined ||
      params.performanceProfile === 'auto'
    if (params.fileAllocation) {
      options['file-allocation'] = params.fileAllocation
    } else if (
      automaticTuning &&
      (params.totalSizeBytes != null || params.protocol != null)
    ) {
      const probe = probeQuick(params.saveDir)
      const context: TuningContext = {
        downloadPath: params.saveDir,
        totalSizeBytes: params.totalSizeBytes ?? null,
        protocol: params.protocol ?? 'http',
        isMultiFile: params.isMultiFile ?? null,
      }
      const rec = recommend(probe, context)
      options['file-allocation'] = rec.fileAllocation
      if (!options.split) options.split = String(rec.split)
      if (!options['min-split-size']) {
        options['min-split-size'] = String(rec.minSplitSize)
      }
      // disk-cache is an aria2 instance-wide startup option, shared by all
      // downloads. EngineSupervisor applies the automatic recommendation
      // before process launch; it is intentionally not sent to addUri here.
    }
    if (params.split != null && !options.split) {
      options.split = String(params.split)
    }
    if (params.minSplitSize != null && !options['min-split-size']) {
      options['min-split-size'] = String(params.minSplitSize)
    }
    if (requestedGid !== undefined) {
      options.gid = requestedGid
    }

    // Resume controls are product safety invariants, not passthrough options.
    // Apply them last so a replay recipe cannot silently weaken or broaden
    // the recovery policy selected by SessionManager.
    const resumePolicy = params.resumePolicy ?? 'none'
    if (resumePolicy === 'checkpoint') {
      options['always-resume'] = 'true'
    } else if (resumePolicy === 'sequential-prefix') {
      options['always-resume'] = 'true'
    }
    options.continue = resumePolicy === 'sequential-prefix' ? 'true' : 'false'

    const actualGid = await this.addUriWithConnectionFallback(
      params.uris,
      options
    )
    if (
      requestedGid !== undefined &&
      actualGid.toLowerCase() !== requestedGid.toLowerCase()
    ) {
      throw new Error(
        `aria2 returned gid ${actualGid} instead of reserved gid ${requestedGid}`
      )
    }
    return requestedGid ?? actualGid
  }

  async pauseTask(engineTaskId: string): Promise<void> {
    await this.rpc.pause(engineTaskId)
  }

  async resumeTask(engineTaskId: string): Promise<void> {
    await this.rpc.unpause(engineTaskId)
  }

  async removeTask(engineTaskId: string): Promise<void> {
    await this.rpc.remove(engineTaskId)
  }

  async forceRemoveTask(engineTaskId: string): Promise<void> {
    try {
      await this.rpc.forceRemove(engineTaskId)
    } catch (err) {
      // A gid evicted between the caller's decision and this call is already
      // in the desired (gone) state — treat "not found" as success, the same
      // idempotent contract removeDownloadResult provides. Keeps aria2's
      // error-message classification inside the adapter so engine-agnostic
      // callers (stopSeedingTask, reAddTask, finalize) don't import it.
      if (isNotFoundError(err)) return
      throw err
    }
  }

  async getEngineTaskOptions(
    engineTaskId: string
  ): Promise<EngineTaskOptions | null> {
    try {
      // aria2 returns options as a struct of strings, but `header`
      // may be an array. Cast through unknown — runtime shape is
      // wider than the rpc client's Record<string, string> hint.
      const raw = (await this.rpc.getOption(
        engineTaskId
      )) as unknown as EngineTaskOptions
      return raw
    } catch (err) {
      if (isNotFoundError(err)) return null
      throw err
    }
  }

  async pauseAll(): Promise<void> {
    await this.rpc.pauseAll()
  }

  async resumeAll(): Promise<void> {
    await this.rpc.unpauseAll()
  }

  async changePosition(
    engineTaskId: string,
    pos: number,
    how: 'POS_SET' | 'POS_CUR' | 'POS_END'
  ): Promise<number> {
    return this.rpc.changePosition(engineTaskId, pos, how)
  }

  async getTaskStatus(engineTaskId: string): Promise<DownloadTask | null> {
    const raw = await this.rpc.tellStatus(engineTaskId)
    return translateRawToTask(raw)
  }

  async getTaskFiles(engineTaskId: string): Promise<TaskFile[]> {
    const rawFiles = await this.rpc.getFiles(engineTaskId)
    return rawFiles.map(translateRawFile)
  }

  async changeOption(
    engineTaskId: string,
    options: Record<string, string>
  ): Promise<void> {
    await this.rpc.changeOption(engineTaskId, options)
  }

  async getTaskPeers(engineTaskId: string): Promise<TaskPeer[]> {
    try {
      const raw = await this.rpc.getPeers(engineTaskId)
      return raw.map(translatePeer)
    } catch {
      // Non-BT tasks and unknown gids both raise on the aria2 side;
      // surface as an empty list so the renderer can render its
      // "no peers" placeholder without branching on adapter errors.
      return []
    }
  }

  async getTaskPieces(engineTaskId: string): Promise<TaskPiecesResult | null> {
    try {
      const raw = (await this.rpc.tellStatus(engineTaskId, [
        'pieceLength',
        'numPieces',
        'bitfield',
      ])) as {
        pieceLength?: string
        numPieces?: string
        bitfield?: string
      }
      return {
        pieceLength: Number.parseInt(raw.pieceLength ?? '0', 10) || 0,
        numPieces: Number.parseInt(raw.numPieces ?? '0', 10) || 0,
        bitfield: typeof raw.bitfield === 'string' ? raw.bitfield : '',
      }
    } catch {
      return null
    }
  }

  async getTaskBtTracker(engineTaskId: string): Promise<string[]> {
    let opts: Record<string, string>
    try {
      opts = await this.rpc.getOption(engineTaskId)
    } catch (err) {
      // BT tasks evicted from aria2 post-seeding (see
      // shouldEvictFromEngine in main/index.ts) no longer have a row,
      // so getOption raises "GID xxx is not found". The TrackersTab
      // should still render the .torrent-native announceList from
      // motrix.db without an error banner. Other failures (RPC down,
      // protocol errors) propagate untouched.
      const msg = err instanceof Error ? err.message : String(err)
      if (/is not found/i.test(msg)) return []
      throw err
    }
    const raw = opts['bt-tracker']
    if (!raw) return []
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  }

  async getGlobalStats(): Promise<GlobalStats> {
    const raw = await this.rpc.getGlobalStat()
    return translateGlobalStat(raw)
  }

  async addTorrent(params: AddTorrentParams): Promise<string> {
    const extraGid = params.extraEngineOptions?.gid
    if (extraGid !== undefined && typeof extraGid !== 'string') {
      throw new TypeError(
        'aria2 addTorrent gid must contain exactly 16 hexadecimal characters'
      )
    }
    const requestedGid =
      params.gid ?? (typeof extraGid === 'string' ? extraGid : undefined)
    const opts: Record<string, string | string[]> = {
      dir: params.saveDir,
      pause: String(params.pause ?? false),
    }
    if (requestedGid !== undefined) {
      if (!/^[0-9a-fA-F]{16}$/.test(requestedGid)) {
        throw new TypeError(
          'aria2 addTorrent gid must contain exactly 16 hexadecimal characters'
        )
      }
    }
    if (params.selectedFiles?.length) {
      opts['select-file'] = params.selectedFiles.join(',')
    }
    if (params.outputFilePaths?.length) {
      const seen = new Set<number>()
      opts['index-out'] = params.outputFilePaths.map(
        ({ fileIndex, relativePath }) => {
          const components = relativePath.replace(/\\/g, '/').split('/')
          if (
            !Number.isSafeInteger(fileIndex) ||
            fileIndex < 0 ||
            seen.has(fileIndex) ||
            relativePath.length === 0 ||
            relativePath.includes('\0') ||
            path.isAbsolute(relativePath) ||
            /^[A-Za-z]:[\\/]/.test(relativePath) ||
            components.some(
              (component) =>
                component.length === 0 ||
                component === '.' ||
                component === '..'
            )
          ) {
            throw new TypeError('Invalid torrent output file mapping')
          }
          seen.add(fileIndex)
          return `${fileIndex + 1}=${relativePath}`
        }
      )
    }
    if (params.seedTime !== undefined) {
      opts['seed-time'] = String(params.seedTime)
    }
    if (params.seedRatio !== undefined) {
      opts['seed-ratio'] = String(params.seedRatio)
    }
    if (params.btSeedUnverified) {
      opts['bt-seed-unverified'] = 'true'
    }
    if (params.checkIntegrity) {
      opts['check-integrity'] = 'true'
    }
    if (params.isPrivate) {
      // Private torrents must not announce to global trackers (BEP-27).
      // Override aria2's engine-wide bt-tracker default with empty string.
      opts['bt-tracker'] = ''
    }
    if (params.prioritizePreviewPieces) {
      opts['bt-prioritize-piece'] = 'head=10M,tail=10M'
    }
    if (params.dlLimit !== undefined) {
      opts['max-download-limit'] = `${params.dlLimit}K`
    }
    if (params.ulLimit !== undefined) {
      opts['max-upload-limit'] = `${params.ulLimit}K`
    }
    if (params.extraEngineOptions) {
      for (const [k, v] of Object.entries(params.extraEngineOptions)) {
        if (RESERVED_TASK_PROXY_OPTIONS.has(k.toLowerCase())) {
          throw new TypeError(`Reserved aria2 proxy option: ${k}`)
        }
        opts[k] = v
      }
    }
    if (requestedGid !== undefined) {
      opts.gid = requestedGid
    }
    const b64 = Buffer.from(params.metadata).toString('base64')
    const actualGid = await this.rpc.addTorrent(b64, [], opts)
    if (
      requestedGid !== undefined &&
      actualGid.toLowerCase() !== requestedGid.toLowerCase()
    ) {
      throw new Error(
        `aria2 returned gid ${actualGid} instead of reserved gid ${requestedGid}`
      )
    }
    return params.gid ?? actualGid
  }

  /**
   * Whether a "GID is not found" reply from this engine can be trusted as
   * durably absent. On a sqlite3-persistence engine that predates
   * 1.37.0-motrix.3, that wording also covers evicted-but-persisted gids and
   * FAILED persistent deletes — so treating it as removed would let callers
   * erase local records while the durable engine row survives. Without
   * persistence there is no durable row a not-found could be hiding, so it is
   * always safe. Shared by the single and batch remove paths.
   */
  private trustsNotFound(): boolean {
    return (
      !this.featureReport.hasSqlitePersistence ||
      hasDurableRemoveSemantics(this.featureReport.version)
    )
  }

  async removeDownloadResult(engineTaskId: string): Promise<void> {
    try {
      await this.rpc.removeDownloadResult(engineTaskId)
    } catch (err) {
      // Idempotent only when aria2 explicitly says the GID is gone AND this
      // engine's not-found is trustworthy. Transport, other RPC failures, and
      // untrusted not-found (pre-.3 persistent fork) must remain observable so
      // callers do not erase local history while the engine row survives.
      if (isNotFoundError(err) && this.trustsNotFound()) return
      throw err
    }
  }

  async removeDownloadResults(
    engineTaskIds: readonly string[]
  ): Promise<PromiseSettledResult<void>[]> {
    const settled: PromiseSettledResult<void>[] = []
    // Same trust rule as the single form: an untrusted not-found (pre-.3
    // persistent fork) stays rejected so clearStoppedTasks retains and retries
    // the candidate instead of erasing a record whose durable engine row
    // survives and would resurrect as an orphan on the next restart.
    const trustNotFound = this.trustsNotFound()
    for (
      let start = 0;
      start < engineTaskIds.length;
      start += REMOVE_RESULT_CHUNK_SIZE
    ) {
      const chunk = engineTaskIds.slice(start, start + REMOVE_RESULT_CHUNK_SIZE)
      let chunkSettled: PromiseSettledResult<unknown>[]
      try {
        chunkSettled = await this.rpc.multicallSettled(
          chunk.map((gid) => ({
            method: 'aria2.removeDownloadResult',
            params: [gid],
          }))
        )
      } catch (err) {
        // Chunk-level transport failure: report this chunk AND everything
        // after it rejected instead of stacking further protocol timeouts
        // against an unresponsive engine. Already-confirmed chunks survive
        // so a retry only re-attempts what actually failed.
        const reason = err instanceof Error ? err : new Error(String(err))
        // One shared entry object for the whole failed suffix — a large
        // history would otherwise allocate a wrapper per remaining gid.
        const rejected: PromiseSettledResult<void> = {
          status: 'rejected',
          reason,
        }
        for (let i = start; i < engineTaskIds.length; i += 1) {
          settled.push(rejected)
        }
        return settled
      }
      if (chunkSettled.length !== chunk.length) {
        // A truncated response makes per-entry attribution unsafe — reject
        // the whole chunk rather than mis-mapping outcomes onto gids.
        const rejected: PromiseSettledResult<void> = {
          status: 'rejected',
          reason: new Error(
            `multicall returned ${chunkSettled.length} entries for ${chunk.length} calls`
          ),
        }
        for (const _gid of chunk) {
          settled.push(rejected)
        }
        continue
      }
      for (const entry of chunkSettled) {
        // Same not-found exemption as the single form, applied per entry —
        // but only when this engine's not-found means durably absent.
        settled.push(
          entry.status === 'rejected' &&
            !(trustNotFound && isNotFoundError(entry.reason))
            ? entry
            : { status: 'fulfilled', value: undefined }
        )
      }
    }
    return settled
  }

  async getUploadLength(engineTaskId: string): Promise<number> {
    try {
      const status = await this.rpc.tellStatus(engineTaskId, ['uploadLength'])
      return Number.parseInt(status.uploadLength ?? '0', 10)
    } catch {
      return 0
    }
  }

  async listActiveAndWaiting(): Promise<
    Array<{ gid: string; infoHash?: string }>
  > {
    const [active, waiting] = await Promise.all([
      this.rpc.tellActive(['gid', 'infoHash']),
      this.rpc.tellWaiting(0, 1000, ['gid', 'infoHash']),
    ])
    return [...active, ...waiting].map((t) => ({
      gid: t.gid,
      infoHash: t.infoHash || undefined,
    }))
  }

  async listStopped(): Promise<Array<{ gid: string; infoHash?: string }>> {
    const stopped = await this.rpc.tellStopped(0, 1000, ['gid', 'infoHash'])
    return stopped.map((t) => ({
      gid: t.gid,
      infoHash: t.infoHash || undefined,
    }))
  }

  async getHistoryCount(filter?: HistoryFilter): Promise<number> {
    const result = await this.rpc.getDownloadResultCount(filter)
    const n = Number.parseInt(result.count, 10)
    if (!Number.isFinite(n)) {
      throw new AppError(
        ErrorCode.EngineProtocolError,
        `Engine returned non-numeric history count: ${result.count}`
      )
    }
    return n
  }

  async searchHistory(
    query: HistorySearchQuery,
    offset: number,
    num: number
  ): Promise<DownloadTask[]> {
    const rows = await this.rpc.searchDownloadResult(query, offset, num)
    return rows.map(translateRawToTask)
  }

  async exportSession(filePath: string): Promise<void> {
    await this.rpc.exportSession(filePath)
  }

  async requeueFromHistory(
    engineTaskId: string,
    overrides?: Record<string, string>
  ): Promise<RequeueResult> {
    const result = await this.rpc.requeueDownloadResult(engineTaskId, overrides)
    return {
      newEngineTaskId: result.gid,
      strategy: result.strategy,
    }
  }

  onBtDownloadComplete(handler: (engineTaskId: string) => void): () => void {
    this.btCompleteHandlers.push(handler)
    return () => {
      this.btCompleteHandlers = this.btCompleteHandlers.filter(
        (h) => h !== handler
      )
    }
  }

  onDownloadComplete(handler: (engineTaskId: string) => void): () => void {
    this.downloadCompleteHandlers.push(handler)
    return () => {
      this.downloadCompleteHandlers = this.downloadCompleteHandlers.filter(
        (h) => h !== handler
      )
    }
  }

  onDownloadError(handler: (engineTaskId: string) => void): () => void {
    this.downloadErrorHandlers.push(handler)
    return () => {
      this.downloadErrorHandlers = this.downloadErrorHandlers.filter(
        (h) => h !== handler
      )
    }
  }
}

function hasC0OrDel(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

function hasRequestHeader(
  headers: ReadonlyArray<readonly [string, string]>,
  expectedName: string
): boolean {
  return headers.some(([name]) => name.toLowerCase() === expectedName)
}

function hasEffectiveCumulativeValue(value: string | undefined): boolean {
  return Boolean(value?.split('\n').some((line) => line.trim().length > 0))
}

function isAria2True(value: string | undefined): boolean {
  return value?.toLowerCase() === 'true'
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}
