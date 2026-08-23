import { access, copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { proxyToAria2Options } from '@core/proxy/serializers'
import type { EngineSettings, ProxySettings } from '@shared/types/settings'
import { dnsModeToAsyncDns } from './dns-fallback'

export class Aria2ConfigBuilder {
  private readonly userConfPath: string
  private readonly defaultDbPath: string
  private readonly saveSessionPath: string
  private readonly dhtFilePath: string
  private readonly dht6FilePath: string

  constructor(
    private templatePath: string,
    private userConfigDir: string
  ) {
    this.userConfPath = path.join(userConfigDir, 'aria2.conf')
    this.defaultDbPath = path.join(userConfigDir, 'aria2.db')
    this.saveSessionPath = path.join(userConfigDir, 'aria2.session')
    this.dhtFilePath = path.join(userConfigDir, 'dht.dat')
    this.dht6FilePath = path.join(userConfigDir, 'dht6.dat')
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
   * @param settings — current engine settings (read for L2/L3 values).
   * @param hasSqlitePersistence — whether the binary supports
   *   `--enable-sqlite3-persistence` (the aria2_motrix fork). Default
   *   true (the bundled binary). When false, the three SQLite flags
   *   are omitted so distro upstream aria2 builds still launch.
   * @param proxy — current proxy settings. When non-null and proxy
   *   is enabled with the `download` scope on, `--all-proxy` (and
   *   optionally `--no-proxy`) are injected at L2.5. Disabled, scope
   *   off, or null proxies emit no proxy flags so aria2 starts in
   *   direct-connection mode.
   * @param effective — effective speed limits from SpeedLimitController
   *   (bytes/sec; 0 = unlimited). On cold start the EngineSupervisor passes
   *   the controller's computed value, or { 0, 0 } if no provider is wired.
   */
  buildArgs(
    settings: EngineSettings,
    hasSqlitePersistence = true,
    proxy: ProxySettings | null | undefined,
    effective: { download: number; upload: number }
  ): string[] {
    // Layer order in the produced argv:
    //   L4 conf-path → L2 engine bindings → L3 user-tunable → L1 invariants
    //
    // Why this order matters: aria2 honors the *last* occurrence of a
    // duplicated flag, so L1 at the tail guarantees the product-contract
    // invariants cannot be silently undone by anything earlier in the
    // chain or by user edits in `aria2.conf`.

    const args: string[] = []

    // ── L4 base conf ──
    args.push(`--conf-path=${this.userConfPath}`)

    // ── L2 engine binding ──
    args.push(
      '--enable-rpc=true',
      '--rpc-allow-origin-all=true',
      '--rpc-listen-all=false',
      `--rpc-listen-port=${settings.rpcPort}`,
      `--rpc-secret=${settings.rpcSecret}`,
      `--listen-port=${settings.listenPort}`,
      `--dht-listen-port=${settings.dhtListenPort}`,
      `--enable-dht=${settings.dhtEnabled}`,
      `--enable-dht6=${settings.dhtEnabled}`,
      `--dht-file-path=${this.dhtFilePath}`,
      `--dht-file-path6=${this.dht6FilePath}`,
      `--save-session=${this.saveSessionPath}`
    )
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

    // ── L2.5 proxy (only when enabled & download scope on) ──
    if (proxy) {
      const opts = proxyToAria2Options(proxy)
      if (opts) {
        args.push(`--all-proxy=${opts.allProxy}`)
        if (opts.noProxy) {
          args.push(`--no-proxy=${opts.noProxy}`)
        }
      }
    }

    // ── L1 product-contract invariants — DO NOT REMOVE without spec change ──
    args.push(
      '--bt-save-metadata=true',
      '--bt-metadata-only=false',
      '--auto-file-renaming=false',
      '--allow-overwrite=false',
      '--rpc-save-upload-metadata=true',
      '--force-save=true',
      '--pause=false',
      '--pause-metadata=false',
      '--bt-seed-unverified=false',
      // Remove unselected files when BT download completes. Without
      // this, piece-boundary writes leak partial / sparse placeholders
      // for every unselected file into saveDir, surfacing as confusing
      // "0-byte" entries in the user's finalized directory. Triggered
      // by aria2's BtPostDownloadHandler — pending source verification
      // of exact ordering vs. onBtDownloadComplete event fire.
      '--bt-remove-unselected-file=true'
    )

    return args
  }
}
