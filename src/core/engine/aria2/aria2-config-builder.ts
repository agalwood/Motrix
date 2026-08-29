import { randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import {
  extractAria2ProxyCredentials,
  stripAria2ProxyCredentials,
} from '@core/proxy/aria2-proxy-routing'
import type { Aria2ProxyOptions } from '@core/proxy/serializers'
import type { EngineSettings } from '@shared/types/settings'
import { dnsModeToAsyncDns } from './dns-fallback'

export interface Aria2ConfigBuilderOptions {
  rpcListenAll?: boolean
}

export class Aria2ConfigBuilder {
  private readonly userConfPath: string
  private readonly defaultDbPath: string
  private readonly saveSessionPath: string
  private readonly dhtFilePath: string
  private readonly dht6FilePath: string
  private readonly rpcListenAll: boolean

  constructor(
    private templatePath: string,
    private userConfigDir: string,
    options: Aria2ConfigBuilderOptions = {}
  ) {
    this.userConfPath = path.join(userConfigDir, 'aria2.conf')
    this.defaultDbPath = path.join(userConfigDir, 'aria2.db')
    this.saveSessionPath = path.join(userConfigDir, 'aria2.session')
    this.dhtFilePath = path.join(userConfigDir, 'dht.dat')
    this.dht6FilePath = path.join(userConfigDir, 'dht6.dat')
    this.rpcListenAll = options.rpcListenAll ?? false
  }

  async ensureUserConfig(): Promise<string> {
    try {
      await access(this.userConfPath)
      return this.userConfPath
    } catch {
      // File does not exist — copy from template
      await mkdir(this.userConfigDir, { recursive: true })
      await copyFile(this.templatePath, this.userConfPath)
      return this.userConfPath
    }
  }

  /**
   * Return whether the standard aria2 text session is available for startup.
   * Any access failure is treated as unavailable so a missing or unreadable
   * fallback file never prevents the engine from launching.
   */
  async hasSavedSession(): Promise<boolean> {
    try {
      await access(this.saveSessionPath)
      return true
    } catch {
      return false
    }
  }

  resolveSqliteDbPath(settings: Pick<EngineSettings, 'sqlite3DbPath'>): string {
    return settings.sqlite3DbPath?.trim() || this.defaultDbPath
  }

  /**
   * Move a corrupt aria2 persistence database and its SQLite companions aside.
   * The files remain recoverable for diagnostics and are never overwritten.
   */
  async quarantineSqliteDatabase(
    settings: Pick<EngineSettings, 'sqlite3DbPath'>,
    token = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
  ): Promise<{
    databasePath: string
    quarantineBasePath: string
    moved: string[]
  }> {
    const databasePath = this.resolveSqliteDbPath(settings)
    const quarantineBasePath = `${databasePath}.corrupt-${token}`
    const moved: string[] = []
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const source = `${databasePath}${suffix}`
      const destination = `${quarantineBasePath}${suffix}`
      try {
        await rename(source, destination)
        moved.push(destination)
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          continue
        }
        throw error
      }
    }
    return { databasePath, quarantineBasePath, moved }
  }

  /**
   * @param settings — current engine settings (read for L2/L3 values).
   * @param hasSqlitePersistence — whether the binary supports
   *   `--enable-sqlite3-persistence` (the aria2_motrix fork). Default
   *   true (the bundled binary). When false, the three SQLite flags
   *   are omitted so distro upstream aria2 builds still launch.
   * @param proxy — resolved aria2-compatible proxy options. SOCKS5 settings
   *   are converted to a loopback HTTP endpoint before reaching this builder.
   *   A null value starts aria2 in direct-connection mode.
   * @param effective — effective speed limits from SpeedLimitController
   *   (bytes/sec; 0 = unlimited). On cold start the EngineSupervisor passes
   *   the controller's computed value, or { 0, 0 } if no provider is wired.
   * @param defaultSaveDir — application default used by JSON-RPC clients that
   *   omit a per-task `dir` option.
   * @param loadTextSession — load the standard aria2.session fallback. The
   *   supervisor enables this only when SQLite persistence is inactive and
   *   the file was verified to exist.
   */
  buildArgs(
    settings: EngineSettings,
    hasSqlitePersistence = true,
    proxy: Aria2ProxyOptions | null | undefined,
    effective: { download: number; upload: number },
    defaultSaveDir: string,
    loadTextSession = false
  ): string[] {
    if (this.rpcListenAll && settings.rpcSecret.trim() === '') {
      throw new Error(
        'External aria2 RPC access requires a non-empty RPC secret'
      )
    }

    // Layer order in the produced argv:
    //   L4 conf-path → L2 engine bindings → L3 user-tunable → L1 invariants
    //
    // Why this order matters: aria2 honors the *last* occurrence of a
    // duplicated flag, so L1 at the tail guarantees the product-contract
    // invariants cannot be silently undone by anything earlier in the
    // chain or by user edits in `aria2.conf`.

    const proxyCredentials = proxy
      ? extractAria2ProxyCredentials(proxy.allProxy)
      : { username: '', password: '' }
    const proxyEndpoint = proxy
      ? stripAria2ProxyCredentials(proxy.allProxy)
      : ''
    if (!proxyCredentials || proxyEndpoint === null) {
      throw new TypeError('Unsupported aria2 proxy credentials')
    }

    const args: string[] = []

    // ── L4 base conf ──
    args.push(`--conf-path=${this.userConfPath}`)

    // ── L2 engine binding ──
    args.push(
      '--enable-rpc=true',
      `--rpc-allow-origin-all=${settings.rpcSecret === '' ? 'false' : 'true'}`,
      `--rpc-listen-all=${this.rpcListenAll}`,
      `--rpc-listen-port=${settings.rpcPort}`
    )
    if (settings.rpcSecret !== '') {
      args.push(`--rpc-secret=${settings.rpcSecret}`)
    }
    args.push(
      `--dir=${defaultSaveDir}`,
      `--listen-port=${settings.listenPort}`,
      `--dht-listen-port=${settings.dhtListenPort}`,
      `--enable-dht=${settings.dhtEnabled}`,
      `--enable-dht6=${settings.dhtEnabled}`,
      `--dht-file-path=${this.dhtFilePath}`,
      `--dht-file-path6=${this.dht6FilePath}`,
      `--save-session=${this.saveSessionPath}`
    )
    const sqliteActive =
      hasSqlitePersistence && settings.sqlite3Persistence === true
    if (!sqliteActive) {
      args.push('--auto-save-interval=10')
    }
    if (loadTextSession && !sqliteActive) {
      args.push(`--input-file=${this.saveSessionPath}`)
    }
    if (hasSqlitePersistence) {
      const dbPath = settings.sqlite3DbPath?.trim() || this.defaultDbPath
      args.push(
        `--enable-sqlite3-persistence=${settings.sqlite3Persistence}`,
        `--sqlite3-db-path=${dbPath}`,
        `--sqlite3-history-limit=${settings.sqlite3HistoryLimit}`
      )
    }

    // ── L3 user-tunable (unchanged) ──
    args.push(
      `--max-concurrent-downloads=${settings.maxConcurrentDownloads}`,
      `--max-overall-download-limit=${effective.download}`,
      `--max-overall-upload-limit=${effective.upload}`,
      `--max-connection-per-server=${settings.maxConnectionPerServer}`,
      `--split=${settings.split}`,
      `--min-split-size=${settings.minSplitSize}`,
      `--user-agent=${settings.userAgent}`,
      `--connect-timeout=${settings.connectTimeout}`,
      `--timeout=${settings.socketTimeout}`,
      `--max-tries=${settings.maxTries}`,
      `--retry-wait=${settings.retryWait}`,
      `--lowest-speed-limit=${settings.lowestSpeedLimit}`,
      // 'auto' starts optimistic (async resolver); the runtime fallback
      // consumer flips it to false via changeGlobalOption when needed.
      `--async-dns=${dnsModeToAsyncDns(settings.dnsMode)}`,
      `--bt-max-peers=${settings.btMaxPeers}`,
      `--bt-enable-lpd=${settings.btEnableLpd}`,
      `--seed-ratio=${settings.seedRatio}`,
      `--seed-time=${settings.seedTime}`,
      `--file-allocation=${settings.fileAllocation}`,
      `--remote-time=${settings.remoteTime}`,
      `--disk-cache=${settings.diskCache}`,
      `--save-session-interval=${settings.sessionSaveInterval}`
    )

    // ── L2.5 proxy ──
    // Always override every ambient/config-file proxy source. aria2 can read
    // protocol-specific proxy values from aria2.conf and conventional proxy
    // environment variables; leaving one unset would make the route differ
    // from the applied snapshot used by metadata validation.
    args.push(
      `--all-proxy=${proxyEndpoint}`,
      '--http-proxy=',
      '--http-proxy-user=',
      '--http-proxy-passwd=',
      '--https-proxy=',
      '--https-proxy-user=',
      '--https-proxy-passwd=',
      '--ftp-proxy=',
      '--ftp-proxy-user=',
      '--ftp-proxy-passwd=',
      `--all-proxy-user=${proxyCredentials.username}`,
      `--all-proxy-passwd=${proxyCredentials.password}`,
      `--no-proxy=${proxy?.noProxy ?? ''}`,
      '--proxy-method=get'
    )

    // ── L1 product-contract invariants — DO NOT REMOVE without spec change ──
    args.push(
      '--bt-save-metadata=true',
      '--bt-metadata-only=false',
      '--auto-file-renaming=false',
      '--allow-overwrite=false',
      '--rpc-save-upload-metadata=true',
      '--force-save=true',
      '--continue=false',
      '--pause=false',
      '--pause-metadata=false',
      '--bt-seed-unverified=false',
      '--http-accept-gzip=true',
      '--no-want-digest-header=false',
      // Remove unselected files when BT download completes. Without
      // this, piece-boundary writes leak partial / sparse placeholders
      // for every unselected file into saveDir, surfacing as confusing
      // "0-byte" entries in the user's finalized directory. Triggered
      // by aria2's BtPostDownloadHandler — pending source verification
      // of exact ordering vs. onBtDownloadComplete event fire.
      '--bt-remove-unselected-file=true'
    )

    // aria2 does not consume argv directly: it rewrites each option into a
    // line-oriented configuration stream. Reject line breaks at this single
    // boundary so every current and future option value is protected from
    // injecting a second configuration directive.
    if (args.some((arg) => /[\r\n]/.test(arg))) {
      throw new TypeError('aria2 option values must not contain CR or LF')
    }
    return args
  }
}
