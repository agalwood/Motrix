import { createHash } from 'node:crypto'
import path from 'node:path'
import { parseTorrent } from '@motrix/torrent'
import { AppError, ErrorCode } from '@shared/errors'
import { MAX_TORRENT_FILE_SIZE } from '@shared/lib/torrent-meta'
import type {
  EngineCapability,
  EngineFeatureReport,
} from '@shared/types/engine'
import type { EngineSettings } from '@shared/types/settings'
import { z } from 'zod'
import { Aria2Adapter } from '../aria2/aria2-adapter'
import { isNotFoundError } from '../aria2/error-utils'
import type { AddTorrentParams, CreateDownloadParams } from '../engine-adapter'
import { taijiFilePadding, toTaijiSelection } from './taiji-file-selection'
import type { TaijiRpcClient } from './taiji-rpc-client'

/**
 * Reuses the compatible task/status translation, with native identity and
 * explicit rejection of recovery contracts that taiji does not implement.
 * Process start/stop remains the EngineSupervisor's responsibility.
 */
export class TaijiAdapter extends Aria2Adapter {
  private nativeCapabilities: EngineCapability = {
    http: false,
    ftp: false,
    bt: false,
    magnet: false,
    metalink: false,
  }

  constructor(
    private readonly taijiRpc: TaijiRpcClient,
    getSeedingDefaults: () =>
      | Pick<EngineSettings, 'seedTime' | 'seedRatio'>
      | undefined = () => undefined
  ) {
    super(taijiRpc, undefined, getSeedingDefaults)
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

  override async createDownload(params: CreateDownloadParams): Promise<string> {
    if (
      params.legacyCheckpointActivation ||
      (params.resumePolicy && params.resumePolicy !== 'none')
    ) {
      throw new AppError(
        ErrorCode.EngineFeatureUnavailable,
        'Legacy file adoption is unavailable in taiji'
      )
    }
    return super.createDownload(params)
  }

  override async addTorrent(params: AddTorrentParams): Promise<string> {
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
    const options = { ...params.extraEngineOptions }
    if (options['index-out'] !== undefined)
      throw new TypeError('Use the typed torrent output mapping')
    const selection = options['select-file'] ?? params.selectedFiles?.join(',')
    if (selection !== undefined) {
      if (typeof selection !== 'string')
        throw new TypeError('Invalid torrent file selection')
      const metadata = parseTorrent(params.metadata, {
        maxBytes: MAX_TORRENT_FILE_SIZE,
        allowUnsortedKeys: true,
      })
      const files = metadata.v1?.files ?? metadata.v2?.files ?? []
      options['select-file'] = toTaijiSelection(
        selection,
        files.map((file) => file.padding)
      )
    }
    return super.addTorrent({
      ...params,
      saveDir: root,
      outputRoot: undefined,
      outputFilePaths: undefined,
      selectedFiles: undefined,
      btSeedUnverified: false,
      checkIntegrity: params.checkIntegrity || params.btSeedUnverified,
      extraEngineOptions: {
        ...options,
        ...(Object.keys(mapping).length
          ? { 'motrix-output-paths': JSON.stringify(mapping) }
          : {}),
      },
    })
  }

  override async changeOption(
    gid: string,
    options: Record<string, string>
  ): Promise<void> {
    if (options['select-file'] !== undefined) {
      const padding = taijiFilePadding(await this.taijiRpc.getFiles(gid))
      options = {
        ...options,
        'select-file': toTaijiSelection(options['select-file'], padding),
      }
    }
    await super.changeOption(gid, options)
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
    try {
      const state = z
        .object({
          'motrix-retry-available': z.literal('true'),
          'motrix-retry-uri-hash': z.string().regex(/^[a-f0-9]{64}$/),
          'motrix-retry-output': z.string().min(1),
        })
        .safeParse(await this.taijiRpc.getOption(input.engineTaskId))
      return (
        state.success &&
        state.data['motrix-retry-uri-hash'] ===
          createHash('sha256').update(input.uri).digest('hex') &&
        path.normalize(state.data['motrix-retry-output']) ===
          path.normalize(input.outputPath)
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
