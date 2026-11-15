import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { TaskCookieError } from '@core/engine/task-cookie-error'
import { getLogger } from '@core/logger'
import type { DownloadProxyOptions } from '@core/proxy/serializers'
import { admitDownloadSources } from '@core/task/source-admission'
import { parseTorrent } from '@motrix/torrent'
import { AppError, ErrorCode } from '@shared/errors'
import { MAX_TORRENT_FILE_SIZE } from '@shared/lib/torrent-meta'
import { torrentManifestRecordSchema } from '@shared/schemas/torrent-manifest'
import {
  type TorrentSelection,
  torrentSelectionSchema,
} from '@shared/schemas/torrent-selection'
import type {
  EngineCapability,
  EngineFeatureReport,
} from '@shared/types/engine'
import type { EngineSettings } from '@shared/types/settings'
import { z } from 'zod'
import { Aria2Adapter } from '../aria2/aria2-adapter'
import { isNotFoundError } from '../aria2/error-utils'
import type { RpcDownloadParams, RpcTorrentParams } from '../aria2/task-options'
import { encodeFileSelection } from '../aria2/task-options'
import type { AddTorrentParams, BtTrackerPolicy } from '../engine-adapter'
import { taijiFilePadding, toTaijiSelection } from './taiji-file-selection'
import { taijiDownloadOptions } from './taiji-request-options'
import type { TaijiRpcClient } from './taiji-rpc-client'
import { taijiProxyOptions, taijiRuntimeSettings } from './taiji-settings'

/**
 * Reuses the compatible task/status translation, with native identity and
 * explicit rejection of recovery contracts that taiji does not implement.
 * Process start/stop remains the EngineSupervisor's responsibility.
 */
export class TaijiAdapter extends Aria2Adapter {
  private metadataReadySubscribed = false

  private prepareDiscovery(): void {
    void this.taijiRpc.prepareBitTorrent().catch((error: unknown) => {
      getLogger('taiji-adapter').debug(
        { error },
        'BT discovery preparation request failed'
      )
    })
  }
  private nativeCapabilities: EngineCapability = {
    http: false,
    ftp: false,
    bt: false,
    magnet: false,
    metalink: false,
  }

  constructor(
    private readonly taijiRpc: TaijiRpcClient,
    private readonly nativeSeedingDefaults: () =>
      | Pick<EngineSettings, 'seedTime' | 'seedRatio'>
      | undefined = () => undefined
  ) {
    super(taijiRpc, undefined, nativeSeedingDefaults)
  }

  private nativeTrackerPolicy?: BtTrackerPolicy
  override configureBtTrackerPolicy(policy: BtTrackerPolicy): void {
    this.nativeTrackerPolicy = policy
  }
  private async applyTrackerPolicy(
    options: Record<string, string | string[]>,
    gid?: string,
    metadata?: Uint8Array,
    isPrivate?: boolean,
    verifiedPrivacy?: boolean
  ): Promise<void> {
    const raw = options['bt-tracker']
    const manual = (Array.isArray(raw) ? raw : (raw ?? '').split(',')).filter(
      Boolean
    )
    const policy = this.nativeTrackerPolicy
      ? await this.nativeTrackerPolicy({
          engineGid: gid,
          metadata,
          isPrivate,
          verifiedPrivacy,
          manual,
        })
      : { isPrivate, trackers: isPrivate ? [] : manual }
    options['bt-tracker'] = policy.trackers.join(',')
    if (policy.isPrivate) options['enable-peer-exchange'] = 'false'
  }
  private seedOptions(
    overrides: Pick<AddTorrentParams, 'seedTime' | 'seedRatio'> = {}
  ): Record<string, string> {
    const defaults = this.nativeSeedingDefaults()
    const time = overrides.seedTime ?? defaults?.seedTime
    const ratio = overrides.seedRatio ?? defaults?.seedRatio
    return {
      ...(time !== undefined ? { 'seed-time': String(time) } : {}),
      ...(ratio !== undefined ? { 'seed-ratio': String(ratio) } : {}),
    }
  }

  async applySettings(
    settings: EngineSettings,
    previous?: EngineSettings
  ): Promise<void> {
    const options = taijiRuntimeSettings(settings, previous)
    if (Object.keys(options).length)
      await this.taijiRpc.changeGlobalOption(options)
    if (settings.dhtEnabled && !previous?.dhtEnabled) this.prepareDiscovery()
  }
  async setSpeedLimits(limits: {
    download: number
    upload: number
  }): Promise<void> {
    await this.taijiRpc.changeGlobalOption({
      'max-overall-download-limit': String(limits.download),
      'max-overall-upload-limit': String(limits.upload),
    })
  }
  async setDefaultSaveDirectory(directory: string): Promise<void> {
    await this.taijiRpc.changeGlobalOption({ dir: directory })
  }
  async setDownloadProxy(proxy: DownloadProxyOptions | null): Promise<void> {
    await this.taijiRpc.changeGlobalOption(taijiProxyOptions(proxy))
  }

  override async connect(): Promise<void> {
    this.clearCapabilities()
    // Identity/authentication failure must propagate; an unknown daemon is
    // never admitted as a usable native engine.
    const { version, enabledFeatures } = await this.taijiRpc.getVersion()
    this.setFeatureReport({
      version,
      features: enabledFeatures,
      hasSqlitePersistence: true,
      hasBtSeedUnverified: false,
      hasBtSaveMetadata: enabledFeatures.includes('BitTorrent'),
      hasMoveStorage: false,
    })
    this.nativeCapabilities = {
      http: enabledFeatures.includes('HTTP'),
      ftp: true,
      bt: enabledFeatures.includes('BitTorrent'),
      magnet: enabledFeatures.includes('BitTorrent'),
      metalink: enabledFeatures.includes('Metalink'),
    }
    this.prepareDiscovery()
  }

  override setFeatureReport(report: EngineFeatureReport): void {
    if (!report.version.startsWith('taiji/')) {
      throw new AppError(
        ErrorCode.EngineProtocolError,
        'Expected a taiji feature report'
      )
    }
    super.setFeatureReport(report)
  }

  override getCapabilities(): EngineCapability {
    return this.nativeCapabilities
  }

  private clearCapabilities(): void {
    this.nativeCapabilities = {
      http: false,
      ftp: false,
      bt: false,
      magnet: false,
      metalink: false,
    }
    super.setFeatureReport({
      version: 'unknown',
      features: [],
      hasSqlitePersistence: false,
      hasBtSeedUnverified: false,
      hasBtSaveMetadata: false,
      hasMoveStorage: false,
    })
    this.setDirectResourceMetadataProfile(null)
  }

  override async disconnect(): Promise<void> {
    this.clearCapabilities()
    await super.disconnect()
  }

  override fetchMagnetMetadata(params: {
    uri: string
    saveDir: string
    engineTaskId?: string
  }): Promise<string> {
    return this.createDownload({
      uris: [params.uri],
      saveDir: params.saveDir,
      gid: params.engineTaskId,
      wireOptions: {
        'motrix-await-selection': 'true',
        'bt-save-metadata': 'false',
      },
    })
  }

  override onTorrentMetadataReady(
    handler: (engineTaskId: string) => void
  ): () => void {
    if (!this.metadataReadySubscribed) {
      this.ownNotificationSubscription(
        this.taijiRpc.onTorrentMetadataReady(({ gid }) =>
          this.emitTorrentMetadataReady(gid)
        )
      )
      this.metadataReadySubscribed = true
    }
    return super.onTorrentMetadataReady(handler)
  }

  getMagnetResolution(engineTaskId: string) {
    return this.taijiRpc.getMagnetResolution(engineTaskId)
  }

  override getTorrentMetadata(engineTaskId: string) {
    return this.taijiRpc.getTorrentManifest(engineTaskId)
  }

  override async confirmTorrentSelection(
    engineTaskId: string,
    input: TorrentSelection
  ): Promise<void> {
    const selection = torrentSelectionSchema.parse(input)
    const padding = taijiFilePadding(await this.taijiRpc.getFiles(engineTaskId))
    if (!path.isAbsolute(selection.saveDir))
      throw new TypeError('Torrent output root must be absolute')
    const paths = Object.fromEntries(
      selection.outputFilePaths.map((file) => [
        file.fileIndex,
        file.relativePath,
      ])
    )
    if (Object.keys(paths).length !== selection.outputFilePaths.length)
      throw new TypeError('Duplicate torrent output mapping')
    if (this.nativeTrackerPolicy) {
      const verified = await this.taijiRpc.getTorrentManifest(engineTaskId)
      if (verified.awaitingSelection) {
        const policyOptions: Record<string, string> = {}
        await this.applyTrackerPolicy(
          policyOptions,
          engineTaskId,
          Buffer.from(verified.data, 'base64'),
          verified.manifest.isPrivate,
          verified.manifest.isPrivate
        )
        await this.taijiRpc.changeOption(engineTaskId, policyOptions)
      }
    }
    const gid = await this.taijiRpc.confirmTorrentSelection(engineTaskId, {
      dir: selection.saveDir,
      'select-file': toTaijiSelection(
        encodeFileSelection(selection.selectedFiles),
        padding
      ),
      'motrix-output-paths': JSON.stringify(paths),
    })
    if (gid !== engineTaskId)
      throw new AppError(
        ErrorCode.EngineProtocolError,
        'Engine changed the task identity'
      )
  }

  async holdHttpOutput(gid: string) {
    await this.taijiRpc.finalizeHttpOutput(gid, 'hold')
    return this.taijiRpc.getHttpOutput(gid)
  }

  getHttpOutput(gid: string) {
    return this.taijiRpc.getHttpOutput(gid)
  }

  finalizeHttpOutput(
    gid: string,
    action: 'publish' | 'external',
    path?: string
  ) {
    return this.taijiRpc.finalizeHttpOutput(gid, action, path)
  }

  override async createDownload(params: RpcDownloadParams): Promise<string> {
    if (
      params.legacyCheckpointActivation ||
      (params.resumePolicy && params.resumePolicy !== 'none')
    ) {
      throw new AppError(
        ErrorCode.EngineFeatureUnavailable,
        'Legacy file adoption is unavailable in taiji'
      )
    }
    if (params.directResourceMetadataProfile)
      throw new AppError(
        ErrorCode.EngineFeatureUnavailable,
        'Request profile is not supported by taiji'
      )
    const uris = admitDownloadSources(params.uris, 'engine').map(
      (source) => source.requestUrl
    )
    const options = taijiDownloadOptions(params)
    if (uris.some((uri) => /^magnet:/i.test(uri))) {
      Object.assign(options, this.seedOptions({ seedRatio: params.seedRatio }))
      await this.applyTrackerPolicy(options, params.gid)
    }
    let cookies = params.cookies
    if (cookies !== undefined) {
      const prepared = this.prepareDownloadCookies(cookies)
      const invalid = prepared.discarded.find(
        (item) => item.reason !== 'expired' && item.reason !== 'duplicate'
      )
      if (invalid) throw new TaskCookieError(invalid)
      cookies = prepared.cookies
    }
    const gid =
      cookies === undefined
        ? await this.taijiRpc.addUri(uris, options)
        : await this.taijiRpc.addUriWithCookies(uris, cookies, options)
    if (params.gid && gid.toLowerCase() !== params.gid.toLowerCase())
      throw new Error('Engine changed the reserved task ID')
    return gid
  }

  override async addTorrent(params: RpcTorrentParams): Promise<string> {
    if (params.legacyCheckpointActivation)
      throw new AppError(
        ErrorCode.EngineFeatureUnavailable,
        'Legacy checkpoint activation requires migration'
      )
    const root = params.outputRoot ?? params.saveDir
    if (!path.isAbsolute(root))
      throw new TypeError('Torrent output root must be absolute')
    const mapping: Record<number, string> = {}
    for (const { fileIndex, relativePath } of params.outputFilePaths ?? []) {
      const parts = relativePath.replaceAll('\\', '/').split('/')
      if (
        !Number.isSafeInteger(fileIndex) ||
        fileIndex < 0 ||
        fileIndex in mapping ||
        parts.some(
          (part) => !part || part === '.' || part === '..' || /[:\0]/.test(part)
        )
      )
        throw new TypeError('Invalid torrent output mapping')
      mapping[fileIndex] = parts.join('/')
    }
    const options = { ...params.wireOptions }
    if (options['index-out'] !== undefined)
      throw new TypeError('Use the typed torrent output mapping')
    const verified = params.verifiedManifest
      ? torrentManifestRecordSchema.parse(params.verifiedManifest)
      : undefined
    if (
      verified &&
      (params.metadata.length > MAX_TORRENT_FILE_SIZE ||
        verified.metadataSha256 !==
          createHash('sha256').update(params.metadata).digest('hex'))
    )
      throw new TypeError('Torrent manifest does not match replay metadata')
    const selection =
      options['select-file'] ??
      (params.selectedFiles?.length
        ? encodeFileSelection(params.selectedFiles)
        : undefined)
    if (selection !== undefined) {
      if (typeof selection !== 'string')
        throw new TypeError('Invalid torrent file selection')
      const metadata = verified
        ? undefined
        : parseTorrent(params.metadata, {
            maxBytes: MAX_TORRENT_FILE_SIZE,
            allowUnsortedKeys: true,
          })
      const files =
        verified?.manifest.files ??
        metadata?.v2?.files ??
        metadata?.v1?.files ??
        []
      options['select-file'] = toTaijiSelection(
        selection,
        files.map((file) => file.padding)
      )
    }
    Object.assign(options, { dir: root, ...this.seedOptions(params) })
    if (params.gid !== undefined) {
      if (!/^[a-f0-9]{16}$/i.test(params.gid))
        throw new TypeError('Invalid engine task ID')
      options.gid = params.gid
    }
    if (params.pause !== undefined) options.pause = String(params.pause)
    if (
      params.checkIntegrity ||
      params.btSeedUnverified ||
      params.preserveExistingFiles
    )
      options['check-integrity'] = 'true'
    if (params.prioritizePreviewPieces)
      options['bt-prioritize-piece'] = 'head=10M,tail=10M'
    if (params.dlLimit !== undefined)
      options['max-download-limit'] = String(params.dlLimit)
    if (params.ulLimit !== undefined)
      options['max-upload-limit'] = String(params.ulLimit)
    if (params.trackers) options['bt-tracker'] = params.trackers.join(',')
    if (Object.keys(mapping).length)
      options['motrix-output-paths'] = JSON.stringify(mapping)
    await this.applyTrackerPolicy(
      options,
      params.gid,
      params.metadata,
      params.isPrivate,
      verified?.manifest.isPrivate
    )
    await mkdir(root, { recursive: true })
    const gid = await this.taijiRpc.addTorrent(
      Buffer.from(params.metadata).toString('base64'),
      [],
      options
    )
    if (params.gid && gid.toLowerCase() !== params.gid.toLowerCase())
      throw new Error('Engine changed the reserved task ID')
    return gid
  }

  override async setSelectedFiles(
    gid: string,
    indices: readonly number[]
  ): Promise<void> {
    const padding = taijiFilePadding(await this.taijiRpc.getFiles(gid))
    await this.taijiRpc.changeOption(gid, {
      'select-file': toTaijiSelection(encodeFileSelection(indices), padding),
    })
  }

  override async getCheckpointStatus(): Promise<null> {
    return null
  }
  override async supportsDirectTaskRetry(): Promise<boolean> {
    return true
  }

  override async canRetryDirectTask(input: {
    engineTaskId: string
    uri: string
    outputPath: string
  }): Promise<boolean> {
    if (!(await this.supportsDirectTaskRetry())) return false
    // The GID's retained request owns its physical paths and validators.
    // A stale host filename must not prevent native resume.
    try {
      const state = z
        .object({
          'motrix-retry-available': z.literal('true'),
          'motrix-retry-uri-hash': z.string().regex(/^[a-f0-9]{64}$/),
        })
        .safeParse(await this.taijiRpc.getOption(input.engineTaskId))
      return (
        state.success &&
        state.data['motrix-retry-uri-hash'] ===
          createHash('sha256').update(input.uri).digest('hex')
      )
    } catch (error) {
      if (isNotFoundError(error)) return false
      throw error
    }
  }

  override async retryDirectTask(input: {
    engineTaskId: string
    uri: string
    outputPath: string
  }): Promise<void> {
    if (!(await this.canRetryDirectTask(input)))
      throw new AppError(
        ErrorCode.EngineFeatureUnavailable,
        'Retained HTTP request is unavailable or changed'
      )
    const gid = await this.taijiRpc.unpause(input.engineTaskId)
    if (gid !== input.engineTaskId)
      throw new Error('taiji retry changed task identity')
  }
  override async supportsLegacyCheckpointImport(): Promise<boolean> {
    return false
  }
  override async supportsLegacyBtActivation(): Promise<boolean> {
    return false
  }
  override async supportsLegacyHttpActivation(): Promise<boolean> {
    return false
  }

  // The aria2 HTTP metadata profile is not evidence of taiji request parity.
  override async inspectDirectResourceMetadataProfile(): Promise<null> {
    return null
  }
}
