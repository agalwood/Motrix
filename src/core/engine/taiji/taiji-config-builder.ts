import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { MAX_TORRENT_RPC_BODY_LIMIT_BYTES } from '@shared/lib/torrent-meta'
import { torrentRpcBodyLimitSchema } from '@shared/schemas/torrent-request-limits'
import type { EngineSettings } from '@shared/types/settings'
import { migrateTaijiSession } from './taiji-session-migration'

export interface TaijiConfigOptions {
  rpcListenAll?: boolean
  supervisorPid?: number
  persistenceDirectory?: string
  rpcMaxRequestSizeBytes?: number
}

/** Only taiji startup options; never reads aria2.conf, aria2.db or text sessions. */
export class TaijiConfigBuilder {
  readonly databasePath: string
  private readonly rpcMaxRequestSizeBytes: number

  constructor(
    private readonly userDataDir: string,
    private readonly options: TaijiConfigOptions = {}
  ) {
    this.databasePath = path.join(
      options.persistenceDirectory ?? userDataDir,
      'taiji.sqlite3'
    )
    this.rpcMaxRequestSizeBytes = torrentRpcBodyLimitSchema.parse(
      options.rpcMaxRequestSizeBytes ?? MAX_TORRENT_RPC_BODY_LIMIT_BYTES
    )
  }

  async prepare(): Promise<void> {
    await mkdir(this.userDataDir, { recursive: true, mode: 0o700 })
    await mkdir(path.dirname(this.databasePath), {
      recursive: true,
      mode: 0o700,
    })
  }

  buildNativeArgs(
    settings: EngineSettings,
    effective: { download: number; upload: number },
    defaultSaveDir: string
  ): string[] {
    // taiji refuses writes without credentials even on loopback.
    if (!settings.rpcSecret.trim())
      throw new TypeError('taiji requires a non-empty RPC secret')
    const args = [
      `--rpc-secret=${settings.rpcSecret}`,
      `--rpc-listen-port=${settings.rpcPort}`,
      `--rpc-listen-all=${this.options.rpcListenAll ?? false}`,
      '--bt-save-metadata=true',
      `--save-session-interval=${settings.sessionSaveInterval}`,
      '--rpc-aria2-compat=false',
      `--rpc-max-request-size=${this.rpcMaxRequestSizeBytes}`,
      `--sqlite3-db-path=${this.databasePath}`,
      `--dir=${defaultSaveDir}`,
      `--listen-port=${settings.listenPort}`,
      `--enable-dht=${settings.dhtEnabled}`,
      `--enable-dht6=${settings.dhtEnabled}`,
      `--bt-enable-lpd=${settings.btEnableLpd}`,
      `--bt-max-peers=${settings.btMaxPeers}`,
      `--seed-ratio=${settings.seedRatio}`,
      `--max-concurrent-downloads=${settings.maxConcurrentDownloads}`,
      `--max-overall-download-limit=${effective.download}`,
      `--max-overall-upload-limit=${effective.upload}`,
      '--bt-enable-upnp=false',
      '--bt-enable-nat-pmp=false',
    ]
    if (args.some((arg) => /[\r\n\0]/.test(arg)))
      throw new TypeError('taiji options must not contain CR, LF or NUL')
    return args
  }
  buildStartupArgs(
    settings: EngineSettings,
    limits: { download: number; upload: number },
    directory: string
  ): string[] {
    return this.buildNativeArgs(settings, limits, directory)
  }
  async migrateSession(
    binaryPath: string,
    settings: EngineSettings,
    defaultSaveDir: string,
    signal?: AbortSignal
  ): Promise<void> {
    const legacy = this.options.persistenceDirectory
      ? path.join(this.options.persistenceDirectory, 'aria2.db')
      : settings.sqlite3DbPath?.trim() ||
        path.join(this.userDataDir, 'aria2.db')
    await migrateTaijiSession(
      binaryPath,
      legacy,
      this.databasePath,
      defaultSaveDir,
      signal
    )
  }
}
