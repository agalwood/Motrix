import type { RunMode } from '../constants'
import type { EnginePerformanceProfile } from '../constants/engine-performance-profiles'
import type { SupportedLocale } from '../constants/locales'
import type { BridgeSettings } from '../schemas/bridge-settings'
import type { GeoIPSettings } from './geoip'
import type { PluginSettings } from './plugin'
import type { TrackerSource } from './tracker'
import type { FileAllocation } from './tuning'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState extends WindowBounds {
  maximized: boolean
}

export interface TrackerSettings {
  autoSync: boolean
  syncIntervalHours: number
  sourcesEnabled: boolean
  sources: TrackerSource[]
  probeEnabled: boolean
  probeTimeoutMs: number
  healthyThresholdMs: number
  minSuccessRate: number
  maxTrackerCount: number
  blacklistEnabled: boolean
  blacklistSources: TrackerSource[]
  // proxyEnabled and proxyServer removed; see proxy.* namespace
}

export type DashboardTileId =
  | 'engine'
  | 'speedUp'
  | 'speedDown'
  | 'active'
  | 'transfer'
  | 'tasks'
  | 'speedLimit'
  | 'nat'
  | 'activity'

export type DashboardTileWidth = 1 | 2 | 3 | 4
export type DashboardTileHeight = 1 | 2 | 3

export interface DashboardTileSpan {
  w: DashboardTileWidth
  h: DashboardTileHeight
}

export interface DashboardTileLayout extends DashboardTileSpan {
  id: DashboardTileId
  enabled: boolean
  x: number
  y: number
}

export interface DashboardLayoutSettings {
  version: 1
  columns: 4
  tiles: DashboardTileLayout[]
}

export type TurtleState = 'off' | 'on' | 'auto'

export type AppUpdateChannel = 'stable' | 'beta'

// Why a limit is currently in effect. `base`/`turtle` describe the off/on
// turtle states; the dashboard tile only surfaces the auto-state reasons
// (schedule/videoApp/adaptive), but the full set is carried in SpeedLimitState
// for other consumers (tray, notifications).
export type SpeedLimitReason =
  | 'none'
  | 'base'
  | 'turtle'
  | 'schedule'
  | 'videoApp'
  | 'adaptive'

export interface SpeedLimitProfile {
  download: number // bytes/sec, 0 = unlimited
  upload: number // bytes/sec, 0 = unlimited
}

export interface SpeedLimitSchedule {
  enabled: boolean
  from: string // "HH:MM" local
  to: string // "HH:MM" local; wraps past midnight when to < from
  days: number[] // 0=Sun..6=Sat; empty = every day
}

export interface SpeedLimitVideoApp {
  enabled: boolean
  processNames: string[]
}

// Phase 2 calibration tooling — data model ships now, unused in Phase 1.
export interface SpeedTestProvider {
  id: string
  label: string
  download: { url: string; sizeParam?: string } | null
  upload: { url: string } | null
}

export interface SpeedTestSettings {
  providers: SpeedTestProvider[]
  selectedProviderId: string
  concurrency: number
  maxDurationSec: number
  maxDataMB: number
}

export interface SpeedLimitAdaptive {
  enabled: boolean
  linkDown: number // bytes/sec
  linkUp: number // bytes/sec
  headroomPercent: number // 1..100
  speedTest: SpeedTestSettings // Phase 2
}

// Auto-mode triggers; consulted only when turtle === 'auto'.
export interface SpeedLimitAutoSettings {
  schedule: SpeedLimitSchedule
  videoApp: SpeedLimitVideoApp // Phase 2
  adaptive: SpeedLimitAdaptive
}

export interface SpeedLimitSettings {
  base: SpeedLimitProfile // always-on floor; 0 = unlimited
  alt: SpeedLimitProfile // alternative / turtle profile
  turtle: TurtleState // off = base only; on = force alt; auto = triggers decide
  auto: SpeedLimitAutoSettings
}

export interface AppSettings {
  version: number
  engine: EngineSettings
  app: MotrixAppSettings
  onboarding: OnboardingState
  nat: NatSettings
  proxy: ProxySettings
  plugins: PluginSettings
  tracker: TrackerSettings
  geoip: GeoIPSettings
  media: MediaSettings
  dashboard: DashboardLayoutSettings
  speedLimit: SpeedLimitSettings
  bridge: BridgeSettings
  windowState: Record<string, WindowState>
}

export interface OnboardingState {
  disclaimerAccepted: boolean
}

/**
 * DNS resolution strategy for the download engine.
 * - `auto`: engine resolver first; on a DNS transport failure the session
 *   falls back to the system resolver and retries the failed task once.
 * - `system`: always the OS resolver (`async-dns=false`).
 * - `engine`: always the engine's built-in async resolver, no fallback.
 */
export type DnsResolutionMode = 'auto' | 'system' | 'engine'

export interface EngineSettings {
  // Startup params (change requires engine restart)
  rpcPort: number
  rpcSecret: string
  listenPort: number
  dhtListenPort: number
  dhtEnabled: boolean

  // Performance profile is resolved at engine start; individual network
  // values remain hot-updatable after entering the custom profile.
  performanceProfile: EnginePerformanceProfile
  maxConcurrentDownloads: number
  maxConnectionPerServer: number
  split: number
  minSplitSize: number

  // Network reliability (HOT)
  userAgent: string
  connectTimeout: number
  socketTimeout: number
  maxTries: number
  retryWait: number
  lowestSpeedLimit: number
  dnsMode: DnsResolutionMode

  // BitTorrent (HOT, flat)
  btMaxPeers: number
  btEnableLpd: boolean
  seedRatio: number
  seedTime: number

  // Disk & session
  fileAllocation: FileAllocation
  remoteTime: boolean
  diskCache: number
  sessionSaveInterval: number

  // SQLite3 persistence (aria2_motrix fork — startup-only, requires restart)
  sqlite3Persistence: boolean
  sqlite3DbPath: string
  sqlite3HistoryLimit: number

  // Magnet (motrix-turbo timer; not aria2)
  magnetResolveTimeout: number
}

export interface MotrixAppSettings {
  launchAtStartup: boolean
  theme: 'system' | 'light' | 'dark'
  language: SupportedLocale
  defaultSaveDir: string
  notifyOnComplete: boolean
  notifyOnError: boolean
  /** When true, opening the New Task dialog reads the clipboard once and
   *  fills the URL field with any link(s) found — only when the field is
   *  empty. One-shot on open; never a background clipboard watcher. */
  autofillClipboardLinks: boolean
  protocols: {
    magnet: boolean
  }
  runMode: RunMode
  /** Release renderer windows while the desktop UI is closed. Background
   *  services such as downloads, notifications, and the tray keep running. */
  lightweightMode: boolean
  traySpeedometer: boolean
  magnetFileSelection: boolean
  /** Master switch for the WebSocket bridge that lets browser extensions
   *  hand downloads to Motrix. Default true. Changing requires app restart. */
  browserBridgeEnabled: boolean
  liquidGlassEffect: boolean
  /** When true, quitting while downloads are active shows a confirmation
   *  dialog. Read live at quit time — no app restart. Default true. */
  warnBeforeQuit: boolean
  /** Check the configured update provider after a packaged app starts.
   *  Downloads and installation always remain user-triggered. Default true. */
  checkForUpdatesOnLaunch: boolean
  /** Application release channel. Stable never accepts prerelease versions;
   *  beta accepts beta and subsequent stable versions. Default stable. */
  updateChannel: AppUpdateChannel
}

export interface NatSettings {
  // Core mapping (LAN-only, no privacy impact)
  enabled: boolean
  preferredProtocol: 'auto' | 'pcp' | 'natpmp' | 'upnp'
  mappingTtl: number
  // NAT type detection via STUN (privacy-sensitive, opt-in)
  natTypeDetectionEnabled: boolean
  stunServers: string[]
  // Port reachability via external service (privacy-sensitive, opt-in)
  portReachabilityCheckEnabled: boolean
  portCheckerEndpoints: string[]
  // Auto-diagnostic scheduling
  autoDiagnostic: boolean
  diagnosticIntervalSec: number
}

export interface MediaSettings {
  // Path to user-provided ffmpeg binary; empty string means auto-detect.
  ffmpegBinaryPath: string
  // Maximum staging disk budget (MB) for ffmpeg stream-copy / remux ops.
  ffmpegStagingMB: number
  // Hard timeout (seconds) for a single ffmpeg invocation.
  ffmpegOpTimeoutSec: number
}

export interface ProxySettings {
  enabled: boolean
  protocol: 'http' | 'https' | 'socks5'
  host: string
  port: number
  user: string
  password: string
  bypass: string[]
  scopes: {
    download: boolean
    updateApp: boolean
    updateTrackers: boolean
  }
}
