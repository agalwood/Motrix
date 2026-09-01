import { mkdir } from 'node:fs/promises'
import { homedir, platform as osPlatform } from 'node:os'
import { join } from 'node:path'
import {
  acquireBridgeDataDirLock,
  type BridgeDataDirLockRecoveryAuthority,
} from '@core/bridge/bridge-data-dir-lock'
import { BridgeEventBus } from '@core/bridge/bridge-event-bus'
import { loadOrCreateBridgeIdentity } from '@core/bridge/bridge-identity'
import { BridgeOwnership } from '@core/bridge/bridge-ownership'
import {
  type CommittedExtensionCredentialWitness,
  Mbp1CredentialStore,
} from '@core/bridge/credential-store'
import { DeviceCodeService } from '@core/bridge/device-code-service'
import { EndpointFileWriter } from '@core/bridge/endpoint-file-writer'
import {
  createExtensionIdentityResolver,
  parseDevTrustedExtensions,
} from '@core/bridge/extension-identity-resolver'
import { ExtensionPairingProjectionService } from '@core/bridge/extension-pairing-projection'
import {
  FileExtensionPairingProjectionStore,
  recoverExtensionPairingProjectionWriterLock,
} from '@core/bridge/file-extension-pairing-projection-store'
import { FilePairingStore } from '@core/bridge/file-pairing-store'
import type { ReadHandlerDeps } from '@core/bridge/handlers/read-handlers'
import type { WriteHandlerDeps } from '@core/bridge/handlers/write-handlers'
import { PairingService } from '@core/bridge/pairing-service'
import { FileRegistryStoreAdapter } from '@core/bridge/registry-store-adapter'
import { resolveCliPair } from '@core/bridge/resolve-cli-pair'
import { toPairedClientInfo } from '@core/bridge/to-paired-client-info'
import { TrustedExtensionRegistry } from '@core/bridge/trusted-extension-registry'
import {
  type ResolveOptions,
  UrlResolutionService,
} from '@core/bridge/url-resolution-service'
import {
  BRIDGE_CANDIDATE_PORTS,
  WebSocketBridgeServer,
} from '@core/bridge/web-socket-bridge-server'
import type { BridgeReceiverDeps } from '@core/bridge-receiver/bridge-receiver'
import { BridgeReceiver } from '@core/bridge-receiver/bridge-receiver'
import { BridgeStreamSource } from '@core/bridge-receiver/bridge-stream-source'
import { urlMatchesHostPermissions } from '@core/plugin/hooks/eligibility'
import type { PluginHost } from '@core/plugin/host/plugin-host'
import type { PluginRegistry } from '@core/plugin/plugin-registry'
import { handleCreateTask } from '@core/task/create-task-handler'
import { Notifications } from '@motrix/mdxp'
import {
  BridgeCommands,
  BridgeEvents,
  BridgeQueries,
  type BridgeStatusInfo,
  type ClientIdentity,
  type PairRequestPayload,
  pairRequestKey,
  type ResolvePairParams,
  type ResolvePairResult,
} from '@shared/protocol/bridge'
import type { BridgeSettings } from '@shared/schemas/bridge-settings'
import type { PluginManifest } from '@shared/types/plugin'
import type { TaskActivityRecorder } from '@shared/types/task-activity'
import { app, ipcMain } from 'electron'
import { CancellationTokenSource } from 'vscode-jsonrpc'
import { registerTrustedIpcHandler } from '../ipc/trusted-ipc'
import { i18n } from '../lib/i18n'
import { isPackagedLinuxFlatpak } from './flatpak-environment'
import { resolveNativeHostBinaryPath } from './native-host-path'
import {
  NativeMessagingInstaller,
  type Platform,
  type SyncArgs,
} from './native-messaging-installer'
import { PairingDialogController } from './pairing-dialog-controller'
import {
  isValidSnapInstanceName,
  type PackagedLinuxSnapEnvironment,
  resolveBridgeDataDir,
  resolvePackagedLinuxSnapEnvironment,
} from './snap-environment'

/**
 * A plugin contributes to the mux pre-resolve seam when it is an enabled
 * `site-resolver` that declares a PUBLIC command whose id is
 * `${manifest.id}.resolve` — the resolve-command marker.
 *
 * Keying off this marker (not the `site-resolver` category alone) is the
 * load-bearing distinction learned in A1: motrix.scraper-hook is also a
 * `site-resolver` whose hostPermissions match all URLs, yet it has NO resolve
 * command (it works via the `beforeCreate` hook, not the mux command seam).
 * Deriving seam membership from the category alone would let it collapse
 * routing to match-everything and send every download through a resolver VM.
 */
function contributesResolveCommand(manifest: PluginManifest): boolean {
  const commands = manifest.contributes?.commands ?? []
  const marker = `${manifest.id}.resolve`
  return commands.some((c) => c.public === true && c.id === marker)
}

/**
 * Build the `resolveToMux` factory for BridgeReceiver. Enumerates enabled
 * site-resolver plugins that contribute a `${id}.resolve` command and whose
 * manifest hostPermissions admit the URL, then tries them in a deterministic
 * order (builtin origin before community, then by id) until one returns a mux
 * pair. No plugin id is hardcoded — the official host ships zero site knowledge;
 * a community resolver contributes its own hostPermissions once installed.
 * Any resolver error or a non-mux result falls through to the next candidate;
 * an empty candidate set returns null → the direct download proceeds.
 */
export function makeResolveToMux(
  pluginRegistry: PluginRegistry,
  pluginHost: PluginHost
): (
  url: string,
  cookieHeader?: string
) => Promise<{
  videoUrl: string
  audioUrl: string
  container: 'mp4' | 'mkv'
  headers?: Record<string, string>
  title?: string
} | null> {
  return async (url: string, cookieHeader?: string) => {
    const candidates = pluginRegistry
      .entries()
      .filter(
        (e) =>
          e.enabled &&
          (e.manifest.categories ?? []).includes('site-resolver') &&
          contributesResolveCommand(e.manifest) &&
          urlMatchesHostPermissions(e.manifest.hostPermissions, url)
      )
      .sort((a, b) => {
        // Deterministic: builtin origin first, then id lexicographic.
        if (a.origin !== b.origin) return a.origin === 'builtin' ? -1 : 1
        return a.manifest.id < b.manifest.id
          ? -1
          : a.manifest.id > b.manifest.id
            ? 1
            : 0
      })

    for (const e of candidates) {
      const id = e.manifest.id
      // Activate + invoke; any failure is non-fatal and falls through to the
      // next candidate. Pass cookies only when present (e.g. bilibili HD) — a
      // resolver whose argsSchema omits `cookies` (additionalProperties:false)
      // must not receive an undefined key, so use a conditional spread.
      try {
        await pluginHost.activate(id)
        const invokeArgs = cookieHeader
          ? { url, cookies: cookieHeader }
          : { url }
        const res = await pluginHost.invokeCommand(
          id,
          `${id}.resolve`,
          invokeArgs
        )
        if (
          res !== null &&
          typeof res === 'object' &&
          (res as Record<string, unknown>).kind === 'mux'
        ) {
          const r = res as {
            video: { url: string; headers?: Record<string, string> }
            audio: { url: string }
            container?: 'mp4' | 'mkv'
            title?: string
          }
          return {
            videoUrl: r.video.url,
            audioUrl: r.audio.url,
            container: r.container ?? 'mp4',
            ...(r.video.headers ? { headers: r.video.headers } : {}),
            ...(r.title ? { title: r.title } : {}),
          }
        }
        // non-mux / null → try the next candidate
      } catch {
        // resolver failed → try the next candidate
      }
    }
    return null
  }
}

function camelize(code: string): string {
  return code.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())
}

/** §4: `fixedPort` resolves to the candidate range, or pins a single port. */
function resolveBridgePorts(
  fixedPort: BridgeSettings['fixedPort']
): readonly number[] {
  return fixedPort === 'auto' ? BRIDGE_CANDIDATE_PORTS : [fixedPort]
}

function extensionIdentityMatchesWitness(
  identity: ClientIdentity & { kind: 'extension' },
  witness: CommittedExtensionCredentialWitness
): boolean {
  return (
    witness.identity.browser === identity.browser &&
    witness.identity.extensionId === identity.extensionId
  )
}

/**
 * How often `sweepExpiredProvisionals()` runs. §6.7 bounds a first-pair
 * provisional's TTL to 10 minutes; sweeping on the same cadence keeps
 * storage hygiene bounded without adding a second timescale to reason about.
 * This is hygiene, not an auth boundary — `findForAuth` already rejects an
 * expired provisional on its own — so a slow sweep only means slower
 * cleanup, never a security gap.
 */
const CREDENTIAL_SWEEP_INTERVAL_MS = 10 * 60 * 1000

export interface BridgeRuntime {
  server: WebSocketBridgeServer
  pairing: PairingService
  extensionPairings: ExtensionPairingProjectionService
  registry: TrustedExtensionRegistry
  bus: BridgeEventBus
  installer: NativeMessagingInstaller
  endpointWriter: EndpointFileWriter
  /** The port actually bound (`startOnFirstFree`'s result). */
  port: number
  /** True once every candidate in `BRIDGE_CANDIDATE_PORTS`/the pinned port
   *  was taken and the bridge fell back to an ephemeral port (§4). */
  degraded: boolean
  shutdown: () => Promise<void>
  /**
   * The shared MuxPipeline used by BridgeReceiver. Exposed read-only so the
   * desktop Add-Task path can reuse the SAME coordinator instance — never
   * construct a second one (that would reintroduce the SP-1 phantom-task bug).
   * Undefined when ffmpeg is unavailable.
   */
  muxPipeline:
    | import('@core/bridge-receiver/pipelines/mux-pipeline').MuxPipeline
    | undefined
  /**
   * Tear down a coordinator-managed media task's in-flight run (segment
   * downloaders + ffmpeg + temp). Used by the remove path so removing a media
   * task's row does not orphan its downloads. No-op once the run has finished.
   */
  cancelMedia: (taskId: string) => Promise<void>
  /**
   * Active aria2 segment gids for a coordinator-managed media task (Mux/Hls),
   * exposed so pause/resume commands can act on the real segment downloads
   * (the task's own engineTaskId is '' — no aria2 handle). Returns [] for any
   * non-media / unknown / past-download-phase task.
   */
  getMediaSegmentGids: (taskId: string) => string[]
  /**
   * The resolveToMux factory (youtube/bilibili → mux pair) used by
   * BridgeReceiver. Exposed so the desktop Add-Task path can call the same
   * resolver without re-constructing it. Always defined when BridgeRuntime is
   * live; the factory itself returns null for non-resolver URLs.
   * The optional cookieHeader arg is forwarded to the plugin for bilibili HD
   * (desktop Add-Task path passes no cookies → ≤480p, by design).
   */
  resolveToMux: (
    url: string,
    cookieHeader?: string
  ) => Promise<{
    videoUrl: string
    audioUrl: string
    container: 'mp4' | 'mkv'
    headers?: Record<string, string>
    title?: string
  } | null>
}

interface NativeMessagingInstallation {
  installer: NativeMessagingInstaller
  snap: PackagedLinuxSnapEnvironment | null
}

function createNativeMessagingInstallation(): NativeMessagingInstallation {
  const platform = osPlatform() as Platform
  const home = homedir()
  const flatpak = isPackagedLinuxFlatpak({
    platform,
    isPackaged: app.isPackaged,
    env: process.env,
  })
  const snap = resolvePackagedLinuxSnapEnvironment({
    platform,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    env: process.env,
  })
  const installationPlatform: Platform = snap ? 'linux' : platform
  const hostBinaryPath = resolveNativeHostBinaryPath({
    platform: installationPlatform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    cwd: process.cwd(),
    devOverride: process.env.MOTRIX_BRIDGE_HOST_BIN,
    ...(snap ? { snapInstanceName: snap.instanceName } : {}),
  })

  return {
    installer: new NativeMessagingInstaller({
      hostBinaryPath,
      manifestRoot: snap?.realHome ?? home,
      platform: installationPlatform,
      ...(installationPlatform === 'win32'
        ? { windowsRoamingAppData: app.getPath('appData') }
        : {}),
      ...(flatpak ? { registrationMode: 'external' as const } : {}),
    }),
    snap,
  }
}

export function createNativeMessagingInstaller(): NativeMessagingInstaller {
  return createNativeMessagingInstallation().installer
}

export async function syncNativeMessagingManifests(args: {
  installer: NativeMessagingInstaller
  manifests: SyncArgs
  snap: PackagedLinuxSnapEnvironment | null
  warn?: (message: string) => void
}): Promise<void> {
  try {
    await args.installer.syncManifests(args.manifests)
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined
    if (
      !args.snap ||
      !isValidSnapInstanceName(args.snap.instanceName) ||
      (code !== 'EACCES' && code !== 'EPERM')
    ) {
      throw error
    }

    const warn = args.warn ?? console.warn
    warn(
      `Browser Native Messaging registration is blocked by Snap confinement. Run "sudo snap connect ${args.snap.instanceName}:browser-native-messaging", then restart Motrix.`
    )
  }
}

export async function bootstrapBridge(args: {
  getMainWindow: () => Electron.BrowserWindow | null
  motrixVersion: string
  ffmpegAvailable: boolean
  enabled: boolean
  // new — required for ③. `off` is needed so the SSE stream source can
  // unsubscribe on shutdown (else listeners leak dead server instances across
  // bridge re-enable cycles).
  eventBus: {
    on(event: string, listener: (payload: unknown) => void): unknown
    off(event: string, listener: (payload: unknown) => void): unknown
  }
  createTaskDeps: Parameters<typeof handleCreateTask>[1]
  activityRecorder: TaskActivityRecorder
  removeTask: (taskId: string) => Promise<void>
  // Bridge magnet submits route through MagnetTracker's metadata-only fetch
  // when file selection is on — mirroring the renderer's Commands.CreateTask
  // path — so the file dialog opens and aria2 doesn't auto-follow into a
  // duplicate BT record. Bound to MagnetTracker.submit (source='bridge') by
  // the caller. isMagnetFileSelectionEnabled is read live per submit.
  submitMagnetForFileSelection: ConstructorParameters<
    typeof BridgeReceiver
  >[0]['submitMagnetForFileSelection']
  isMagnetFileSelectionEnabled: ConstructorParameters<
    typeof BridgeReceiver
  >[0]['isMagnetFileSelectionEnabled']
  finalNamePicker: { pick(saveDir: string, desired: string): Promise<string> }
  defaultSaveDir: string
  // Spec 3 — v1 READ methods over the unary POST /mdxp transport.
  readHandlerDeps: ReadHandlerDeps
  // Spec 4 — v1 WRITE methods (pause/resume/remove/add).
  writeHandlerDeps: WriteHandlerDeps
  // T14/T15 media pipeline deps. Threaded here so T15 can inject real values.
  // Until T15 wires them, ffmpegBinaryPath=null disables the media pipeline.
  ffmpegBinaryPath: string | null
  /** Re-resolves the current executable immediately before each mux. */
  resolveFfmpegBinaryPath?: BridgeReceiverDeps['resolveFfmpegBinaryPath']
  /** Coalesced / immediate TaskUpdated publication (TaskUpdatePublisher),
   *  threaded through BridgeReceiver into the MediaTaskCoordinator. */
  publishTaskUpdate: () => void
  publishTaskUpdateNow: () => void
  taskManager: BridgeReceiverDeps['taskManager']
  segmentAria2: BridgeReceiverDeps['segmentAria2']
  tmpRoot: string
  persistTask: BridgeReceiverDeps['persistTask']
  persistTaskWithOccurrence?: BridgeReceiverDeps['persistTaskWithOccurrence']
  occurrenceDispatcher?: BridgeReceiverDeps['occurrenceDispatcher']
  parentTaskCreated: BridgeReceiverDeps['parentTaskCreated']
  recordTransition: BridgeReceiverDeps['recordTransition']
  runTaskMutation: BridgeReceiverDeps['runTaskMutation']
  /** Main-process shutdown gate/drain for renderer bridge IPC handlers. */
  trackAsyncWork: <T>(operation: () => Promise<T>) => Promise<T>
  // Startup barrier: submits await this before any pipeline work reaches the
  // engine, so a submit racing SessionManager.restore() can't get clobbered
  // by its clear() + orphan re-adopt. Optional — Node shell / tests omit it.
  waitForReady?: BridgeReceiverDeps['waitForReady']
  // Plugin subsystem — used to build the resolveToMux pre-resolver
  // (youtube + bilibili → mux task via the url-resolver plugin).
  pluginRegistry: PluginRegistry
  pluginHost: PluginHost
  /** `bridge.fixedPort` (port policy, §4) + `bridge.instanceId` (the §4.1
   *  discovery routing hint) from persisted settings. */
  bridgeSettings: BridgeSettings
  /** Electron single-instance ownership, acquired before bridge bootstrap. */
  bridgeDataDirLockRecoveryAuthority: BridgeDataDirLockRecoveryAuthority
  /** Test-only override for `sweepExpiredProvisionals()`'s cadence —
   *  production always relies on {@link CREDENTIAL_SWEEP_INTERVAL_MS}. */
  credentialSweepIntervalMs?: number
}): Promise<BridgeRuntime | null> {
  if (!args.enabled) {
    return null
  }
  const dataDir = resolveBridgeDataDir(
    app.getPath('userData'),
    process.env.MOTRIX_BRIDGE_DATA_DIR
  )
  await mkdir(dataDir, { recursive: true })
  const ownership = new BridgeOwnership()
  try {
    // This is the first bridge-state acquisition. No store is loaded and no
    // listener is constructed until the process owns the entire data root.
    const dataDirLock = await acquireBridgeDataDirLock(dataDir, {
      recoverExisting: args.bridgeDataDirLockRecoveryAuthority,
    })
    // BridgeOwnership disposes in reverse order, so registering the lock first
    // keeps it held until every listener, callback and persistence queue drains.
    ownership.own('bridge-data-dir-lock', () => dataDirLock.release())
    await recoverExtensionPairingProjectionWriterLock(
      join(dataDir, 'extension-pairings.json'),
      dataDirLock
    )
    // pairing.json lives under bridge/ alongside its siblings (registry.json,
    // endpoint.json, receiver/) rather than at the userData root, so the whole
    // bridge subsystem state is grouped in one place.
    const pairingStore = new FilePairingStore(join(dataDir, 'pairing.json'))
    const registryStore = new FileRegistryStoreAdapter(
      join(dataDir, 'registry.json')
    )

    const pairing = new PairingService(pairingStore)
    await pairing.load()

    const devTrusted = parseDevTrustedExtensions(
      process.env.MOTRIX_DEV_TRUSTED_EXTENSIONS
    )
    const identityResolver = createExtensionIdentityResolver({
      // `app.isPackaged` is authoritative for shipped builds. The NODE_ENV
      // check also closes an unpackaged production build: an env-provided dev
      // id never reaches the official tier in either production shape.
      environment:
        app.isPackaged || process.env.NODE_ENV === 'production'
          ? 'production'
          : 'non-production',
      developmentEntries: devTrusted,
    })
    // The resolver owns immutable official inputs and never reads the registry,
    // whose persisted user-added/imported entries therefore cannot raise trust.
    const registry = new TrustedExtensionRegistry(registryStore, [
      ...identityResolver.officialEntries,
    ])
    await registry.load()

    const bus = new BridgeEventBus()
    const dialog = new PairingDialogController(bus, args.getMainWindow)
    // Device-code pairing for cli/agent clients (Spec 7b): the HTTP routes call
    // request()/poll(); the renderer ResolvePair handler calls approve()/deny().
    // onLifecycle re-emits the same renderer lifecycle DTOs as the extension
    // prompt adapter, so the approval inbox sees one shape across pairing kinds.
    const deviceCode = new DeviceCodeService(pairing, {
      onLifecycle: {
        settled: (requestId, outcome) =>
          bus.emitPairRequestSettled({
            key: pairRequestKey({ kind: 'cli', requestId }),
            outcome,
          }),
        expired: (requestId) =>
          bus.emitPairRequestExpired({
            key: pairRequestKey({ kind: 'cli', requestId }),
          }),
      },
    })

    // Forward bus events to the renderer. The webContents lookup is deferred
    // (called per-event) so that window-recreation paths see the current window.
    const forwardToRenderer = (channel: string, payload: unknown) => {
      const win = args.getMainWindow()
      win?.webContents.send(channel, payload)
    }
    bus.on('PairRequested', (p) => {
      forwardToRenderer(BridgeEvents.PairRequested, p)
      // #1: a device-code (cli) prompt has no PairingDialogController, so surface
      // the window here — the same restore()/focus() the extension flow does.
      if ((p as PairRequestPayload).kind === 'cli') {
        const win = args.getMainWindow()
        if (win) {
          if (win.isMinimized()) win.restore()
          win.focus()
        }
      }
    })
    bus.on('Paired', (p) => forwardToRenderer(BridgeEvents.Paired, p))
    bus.on('Revoked', (p) => forwardToRenderer(BridgeEvents.Revoked, p))
    bus.on('Error', (p) => forwardToRenderer(BridgeEvents.Error, p))
    // Pending pair request lifecycle (pending -> settled | expired) — drives the
    // approval inbox's live countdown/removal on the renderer side.
    bus.on('PairRequestSettled', (p) =>
      forwardToRenderer(BridgeEvents.PairRequestSettled, p)
    )
    bus.on('PairRequestExpired', (p) =>
      forwardToRenderer(BridgeEvents.PairRequestExpired, p)
    )

    // ─── bridge receiver (subsystem ③) ───────────────────
    // Constructed BEFORE WebSocketBridgeServer so that setHandlers() can
    // reference receiver before server.start() is called — eliminating the
    // race window where the server is listening but handlers aren't registered.
    const receiverDataDir = join(dataDir, 'receiver')
    const t = i18n.t.bind(i18n)
    const localize = (code: string) =>
      t(`bridge.receiver.error.${camelize(code)}`)

    // Build the resolver once — shared between BridgeReceiver (extension submit-
    // path) and the BridgeRuntime surface (desktop Add-Task path). A single
    // instance ensures both paths see the same plugin registry state.
    const resolveToMuxFn = makeResolveToMux(
      args.pluginRegistry,
      args.pluginHost
    )
    const receiver = new BridgeReceiver({
      dataDir: receiverDataDir,
      defaultSaveDir: args.defaultSaveDir,
      pickName: (saveDir, desired) =>
        args.finalNamePicker.pick(saveDir, desired),
      createTask: (req, _deps, options) =>
        handleCreateTask(req, args.createTaskDeps, options),
      removeTask: args.removeTask,
      submitMagnetForFileSelection: args.submitMagnetForFileSelection,
      isMagnetFileSelectionEnabled: args.isMagnetFileSelectionEnabled,
      eventBus: args.eventBus,
      bridgeBus: bus,
      localize,
      ffmpegBinaryPath: args.ffmpegBinaryPath,
      resolveFfmpegBinaryPath: args.resolveFfmpegBinaryPath,
      publishTaskUpdate: args.publishTaskUpdate,
      publishTaskUpdateNow: args.publishTaskUpdateNow,
      taskManager: args.taskManager,
      activityRecorder: args.activityRecorder,
      segmentAria2: args.segmentAria2,
      tmpRoot: args.tmpRoot,
      resolveToMux: resolveToMuxFn,
      persistTask: args.persistTask,
      persistTaskWithOccurrence: args.persistTaskWithOccurrence,
      occurrenceDispatcher: args.occurrenceDispatcher,
      parentTaskCreated: args.parentTaskCreated,
      recordTransition: args.recordTransition,
      runTaskMutation: args.runTaskMutation,
      ...(args.waitForReady ? { waitForReady: args.waitForReady } : {}),
    })
    // restoreInflight() may resume coordinator-owned jobs before it rejects.
    // Cache cleanup ownership first so every partial restore/start is drained.
    ownership.own('receiver', () => receiver.stopAndDrain())
    await receiver.restoreInflight()
    receiver.start()

    // Machine-owner Bearer token for the unary POST /mdxp transport, AND the
    // §9.1 attestation root the native host derives its ticket-MAC key from.
    // MUST persist across restarts (§9.2) — a ticket minted before a restart
    // must MAC-verify after one, downgrading to `unverified` on a stale
    // `serverGeneration` rather than aborting outright. `serverGeneration`
    // itself is the opposite: fresh per start, so a replayed pre-restart
    // ticket cannot be mistaken for a live one.
    const bridgeIdentity = await loadOrCreateBridgeIdentity(
      join(dataDir, 'local-token')
    )

    // §6.7's durable credential store, shared by both the first-pair and
    // reconnect session paths. Loaded BEFORE the listener starts — its
    // journal replay must finish before /v1 accepts any authentication.
    const credentials = await Mbp1CredentialStore.load(
      join(dataDir, 'mbp1-credentials.json')
    )
    const extensionPairings = new ExtensionPairingProjectionService(
      new FileExtensionPairingProjectionStore(
        join(dataDir, 'extension-pairings.json')
      )
    )
    await extensionPairings.load()
    // Storage hygiene only (findForAuth already rejects an expired
    // provisional on its own) — periodic so an unbounded number of crashed
    // first-pair attempts cannot accumulate for the life of a long-running
    // process.
    const sweepTimer = setInterval(
      () => void credentials.sweepExpiredProvisionals(),
      args.credentialSweepIntervalMs ?? CREDENTIAL_SWEEP_INTERVAL_MS
    )
    sweepTimer.unref()
    ownership.own('credential-sweep', () => {
      clearInterval(sweepTimer)
    })
    ownership.own('extension-pairings', () => extensionPairings.stopAndDrain())

    let server: WebSocketBridgeServer
    const quarantineProjectionFailure = (
      identity: ClientIdentity & { kind: 'extension' }
    ): void => {
      try {
        const revokeLease = server.beginExtensionRevocation(identity)
        server.retainFailedExtensionRevocation(revokeLease)
      } catch {
        // The fixed operator signal below remains the observable failure. A
        // malformed callback identity must not leak its value or resurrect a
        // session by escaping this quarantine path.
      }
      bus.emitError({
        code: 'extensionProjectionDegraded',
        message:
          'Extension pairing state could not be updated; access is closed until startup repair.',
      })
    }

    server = new WebSocketBridgeServer({
      pairing,
      registry,
      motrixVersion: args.motrixVersion,
      runtime: 'electron',
      ffmpegAvailable: args.ffmpegAvailable,
      localToken: bridgeIdentity.localToken,
      deviceCode,
      // A device-code pair/request surfaces the SAME approval prompt the
      // extension flow uses — emit on the bus, which forwards to the renderer.
      onPairRequested: (payload) => bus.emitPairRequested(payload),
      instanceId: args.bridgeSettings.instanceId,
      serverGeneration: bridgeIdentity.serverGeneration,
      appVersion: args.motrixVersion,
      credentials,
      isOfficialId: (browser, id) => identityResolver.isOfficialId(browser, id),
      queueMbp1Dialog: (req) => dialog.queueMbp1Prompt(req),
      canAdmitExtensionIdentity: (identity) =>
        extensionPairings.canAdmitIdentity(identity),
      // The only remaining signal that an extension became usable now that
      // `motrix/initialize` mints nothing (R18-10): refresh the extension
      // management projection from the authoritative MBP1 credential set, then
      // emit the paired event. Best-effort: display persistence must not tear
      // down the durable credential, but an unlisted session is not safe to
      // keep usable in this process. Projection failure therefore gates and
      // closes this identity until startup reconciliation can make it visible.
      onExtensionAuthenticated: (identity, credentialId) => {
        try {
          void args
            .trackAsyncWork(async () => {
              const witness =
                await credentials.issueCommittedExtensionWitness(credentialId)
              if (!extensionIdentityMatchesWitness(identity, witness)) {
                throw new Error('authenticated extension identity mismatch')
              }
              await extensionPairings.recordAuthenticated(witness, Date.now())
              bus.emitPaired({ identity })
            })
            .catch(() => quarantineProjectionFailure(identity))
        } catch {
          quarantineProjectionFailure(identity)
        }
      },
    })

    // A crash may leave a durable pending-revoke marker after either side of
    // credential deletion. Restore its verified-identity gate and finish the
    // delete before any listener exists. Generic snapshot reconciliation must
    // never infer that a surviving old credential cancels the operator's
    // revoke intent.
    for (const pending of extensionPairings
      .list()
      .filter((record) => record.status === 'cleanup-pending')) {
      const serverLease = server.beginExtensionRevocation(pending.identity)
      const projectionLease = await extensionPairings.prepareIdentityCleanup(
        pending.identity
      )
      try {
        await server.deleteExtensionAuthorization(serverLease, 'user-revoked')
        const absenceWitness =
          await credentials.issueExtensionIdentityAbsenceWitness(
            pending.identity.browser,
            pending.identity.extensionId
          )
        await extensionPairings.completeCleanup(projectionLease, absenceWitness)
        server.completeExtensionRevocation(serverLease)
      } catch {
        server.retainFailedExtensionRevocation(serverLease)
        throw new Error('extension revocation recovery failed')
      }
    }
    await extensionPairings.reconcileCommitted(
      await credentials.issueCommittedExtensionSnapshot()
    )

    // Register the shell's domain handlers BEFORE start() — no race window where
    // the server is listening but handlers aren't yet registered. motrix/initialize
    // and system/ping are wired by the server itself; the dispatcher validates
    // params at the boundary, so these handlers receive already-typed values.
    server.setHandlers({
      submitDownload: (params, ctx) => receiver.handle(params, ctx),
      cancelDownload: async (params) => {
        await receiver.cancel(params.taskId)
      },
    })
    // v1 READ methods (task/list, task/get, stats/get, engine/status) — also
    // before start(), reachable via the unary POST /mdxp transport only.
    server.registerReadMethods(args.readHandlerDeps)
    // v1 WRITE methods (task/pause, task/resume, task/remove, download/add).
    server.registerWriteMethods(args.writeHandlerDeps)

    const urlResolution = new UrlResolutionService(() =>
      Array.from(server.iterSessions())
        .filter((s) => s.conn.isReady())
        .map((s) => s.conn)
    )

    // Acquire persistence ownership before the listener so reverse-order
    // shutdown first stops request admission, then drains every markActive
    // write accepted by that listener. The receiver remains the outer owner
    // and drains after the bridge-facing resources are quiet.
    ownership.own('pairing-persistence', () => pairing.stopAndDrain())
    // Register before bind so even a partial listen failure closes every
    // socket/dispatcher resource the server may already own.
    ownership.own('server', () => server.stop())
    const { port, degraded } = await server.startOnFirstFree(
      '127.0.0.1',
      resolveBridgePorts(args.bridgeSettings.fixedPort)
    )

    bus.on('TaskProgress', ({ sessionKey, params }) => {
      const session = server.getSession(sessionKey)
      session?.conn.sendNotification(Notifications.TaskProgress, params)
    })
    bus.on('TaskCompleted', ({ sessionKey, params }) => {
      const session = server.getSession(sessionKey)
      session?.conn.sendNotification(Notifications.TaskCompleted, params)
    })
    bus.on('TaskError', ({ sessionKey, params }) => {
      const session = server.getSession(sessionKey)
      session?.conn.sendNotification(Notifications.TaskError, params)
    })

    // Spec 5 — global SSE firehose. BridgeStreamSource subscribes the core
    // EventBus (ALL tasks, no session scope) and derives the MDXP $/task/* +
    // $/stats notifications from Events.TaskUpdated (the full task list each poll
    // tick) + Events.StatsUpdated, broadcasting them to GET /mdxp/events clients.
    // Independent of the per-session extension WS push above (different bus).
    // Detached on shutdown so its listeners don't leak across re-enable cycles.
    const streamSource = new BridgeStreamSource(server, localize)
    ownership.own('stream-source', () => streamSource.detach(args.eventBus))
    streamSource.attach(args.eventBus)

    // Abort every code prompt before server.stop() tears down its PairSession,
    // and await code-free terminal event publication during the drain.
    ownership.own('pairing-dialog', () => dialog.dispose())
    // Clear every device-code TTL timer so none fires — into a torn-down bus —
    // after this bridge instance is gone.
    ownership.own('device-code', () => deviceCode.dispose())

    const { installer, snap } = createNativeMessagingInstallation()
    let preserveNativeMessagingRegistration = false
    ownership.own('native-messaging-manifests', async () => {
      if (!preserveNativeMessagingRegistration) {
        await installer.unregister()
      }
    })
    await syncNativeMessagingManifests({
      installer,
      snap,
      manifests: {
        chromium: registry.listManifestIds('chromium'),
        firefox: registry.listManifestIds('firefox'),
      },
    })

    const endpointWriter = new EndpointFileWriter(
      join(dataDir, 'endpoint.json')
    )
    // clear() is owned before write(): a faulting write may have replaced or
    // partially created the discovery file before rejecting.
    ownership.own('endpoint', () => endpointWriter.clear())
    await endpointWriter.write(
      port,
      bridgeIdentity.localToken,
      bridgeIdentity.serverGeneration
    )

    // Renderer IPC. Track exact channels as each registration succeeds; a
    // later duplicate/fault removes the earlier subset during rollback.
    const installedIpcChannels: string[] = []
    ownership.own('renderer-ipc', () => {
      for (const channel of installedIpcChannels.splice(0)) {
        ipcMain.removeHandler(channel)
      }
    })
    const installIpcHandler = (
      channel: string,
      listener: Parameters<typeof ipcMain.handle>[1]
    ): void => {
      registerTrustedIpcHandler(channel, (...listenerArgs) =>
        args.trackAsyncWork(async () => listener(...listenerArgs))
      )
      installedIpcChannels.push(channel)
    }

    installIpcHandler(BridgeQueries.ListPaired, () => [
      ...extensionPairings.list().map(toPairedClientInfo),
      ...pairing
        .listPaired()
        .filter((entry) => entry.identity.kind === 'cli')
        .map(toPairedClientInfo),
    ])
    // Merged snapshot: a cli device-code request and an extension /pair
    // prompt are both "pending pair requests" for the approval inbox — union
    // them so the renderer sees one list regardless of kind.
    installIpcHandler(BridgeQueries.ListPendingPairRequests, () => [
      ...deviceCode.listPending(),
      ...dialog.listPending(),
    ])
    installIpcHandler(BridgeQueries.ListTrusted, () => registry.list())
    installIpcHandler(
      BridgeQueries.GetStatus,
      (): BridgeStatusInfo => ({
        port,
        degraded,
        extensionPairingHealth:
          extensionPairings.getHealth() === 'ready' ? 'ready' : 'degraded',
        fixedPort: args.bridgeSettings.fixedPort,
        instanceId: args.bridgeSettings.instanceId,
      })
    )
    installIpcHandler(
      BridgeCommands.RevokePair,
      async (_e, params: { identity: ClientIdentity }) => {
        const reason = 'user-revoked'
        if (params.identity.kind === 'extension') {
          const extensionIdentity = params.identity
          // This synchronous call MUST precede every snapshot or durable
          // projection await. It immediately de-authorizes live MDXP, cancels
          // pre-auth sessions, and rejects new pair/reconnect attempts.
          const serverLease = server.beginExtensionRevocation(extensionIdentity)
          let markerPersisted = false

          try {
            const cleanupLease =
              await extensionPairings.prepareIdentityCleanup(extensionIdentity)
            markerPersisted = true
            await server.deleteExtensionAuthorization(serverLease, reason)
            const absenceWitness =
              await credentials.issueExtensionIdentityAbsenceWitness(
                extensionIdentity.browser,
                extensionIdentity.extensionId
              )
            await extensionPairings.completeCleanup(
              cleanupLease,
              absenceWitness
            )
            server.completeExtensionRevocation(serverLease)
          } catch {
            // Never infer that persistence failure cancels a user revoke. The
            // identity remains gated and its transport is closed. A durable
            // marker is retried before the next listener; if the marker itself
            // could not be written, the warning explicitly names the restart
            // limitation instead of falsely reporting success.
            server.retainFailedExtensionRevocation(serverLease)
            bus.emitError({
              code: markerPersisted
                ? 'extensionRevocationIncomplete'
                : 'extensionRevocationMarkerFailed',
              message: markerPersisted
                ? 'Extension revocation is incomplete; access remains closed and startup will retry it.'
                : 'Extension revocation could not be recorded; access is closed for this run, but restart may restore the old credential.',
            })
            throw new Error('extension revocation incomplete')
          }
        } else {
          await pairing.revoke(params.identity, reason)
        }
        bus.emitRevoked({ identity: params.identity })
      }
    )
    installIpcHandler(
      BridgeCommands.AddTrusted,
      async (
        _e,
        params: {
          id: string
          browser: 'chromium' | 'firefox'
          label?: string
        }
      ) => {
        await registry.add(
          params.id,
          params.browser,
          'user-added',
          params.label
        )
        await syncNativeMessagingManifests({
          installer,
          snap,
          manifests: {
            chromium: registry.listManifestIds('chromium'),
            firefox: registry.listManifestIds('firefox'),
          },
        })
      }
    )
    installIpcHandler(
      BridgeCommands.RemoveTrusted,
      async (_e, params: { id: string; browser: 'chromium' | 'firefox' }) => {
        await registry.remove(params.id, params.browser)
        await syncNativeMessagingManifests({
          installer,
          snap,
          manifests: {
            chromium: registry.listManifestIds('chromium'),
            firefox: registry.listManifestIds('firefox'),
          },
        })
      }
    )

    // Renderer-side pair command. A cli explicitly allows/denies a device-code
    // request; an extension action is deny-only because approval is the PAKE
    // code entered in the extension, never a Motrix button.
    installIpcHandler(
      BridgeCommands.ResolvePair,
      async (_e, params: ResolvePairParams): Promise<ResolvePairResult> => {
        if (params.kind === 'cli') {
          return resolveCliPair(deviceCode, params, (paired) =>
            bus.emitPaired({ identity: paired.identity })
          )
        }
        return dialog.settle(params)
      }
    )

    installIpcHandler(BridgeQueries.ProbeUrl, (_e, url: string) =>
      urlResolution.probe(url)
    )

    const inFlightResolves = new Map<string, CancellationTokenSource>()
    ownership.own('url-resolutions', () => {
      for (const cts of inFlightResolves.values()) cts.cancel()
      inFlightResolves.clear()
    })

    installIpcHandler(
      BridgeQueries.ResolveUrl,
      async (
        _e,
        requestId: string,
        url: string,
        options: ResolveOptions = {}
      ) => {
        const cts = new CancellationTokenSource()
        inFlightResolves.set(requestId, cts)
        try {
          return await urlResolution.resolve(url, options, cts.token)
        } finally {
          inFlightResolves.delete(requestId)
        }
      }
    )

    installIpcHandler(
      BridgeQueries.CancelResolveUrl,
      (_e, requestId: string) => {
        const cts = inFlightResolves.get(requestId)
        cts?.cancel()
      }
    )

    // Native Messaging registration is process-independent and intentionally
    // survives a normal app quit. Only startup rollback unregisters it.
    preserveNativeMessagingRegistration = true
    return {
      server,
      pairing,
      extensionPairings,
      registry,
      bus,
      installer,
      endpointWriter,
      port,
      degraded,
      shutdown: () => ownership.dispose(),
      muxPipeline: receiver.muxPipeline,
      getMediaSegmentGids: (taskId: string) =>
        receiver.getMediaSegmentGids(taskId),
      cancelMedia: (taskId: string) => receiver.cancelMedia(taskId),
      resolveToMux: resolveToMuxFn,
    }
  } catch (error) {
    return ownership.rollback(error)
  }
}
