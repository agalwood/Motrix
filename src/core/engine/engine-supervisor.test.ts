import { registerEngineFailureSubscriber } from '@core/notifications/engine-failure-subscriber'
import { NotificationCenter } from '@core/notifications/notification-center'
import { MotrixDatabase } from '@core/session/motrix-database'
import { ErrorCode } from '@shared/errors'
import { Events } from '@shared/protocol/events'
import type {
  EngineFailurePayload,
  EngineFeatureReport,
} from '@shared/types/engine'
import {
  EngineFailureReason,
  EngineProcessOwnership,
  EngineRecoveryAction,
  EngineState,
} from '@shared/types/engine'
import { NotificationKinds } from '@shared/types/notification'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus } from '../events/event-bus'
import type { SettingsManager } from '../settings/settings-manager'
import type { Aria2Adapter } from './aria2/aria2-adapter'
import type { Aria2ConfigBuilder } from './aria2/aria2-config-builder'
import type { Aria2ProcessManager } from './aria2/aria2-process-manager'
import type { Aria2RpcClient } from './aria2/aria2-rpc-client'
import type { Aria2TrustStore } from './aria2/aria2-trust-store'
import { EngineSupervisor } from './engine-supervisor'
import { checkPort } from './port-check'

const { probePreciseMock } = vi.hoisted(() => ({
  probePreciseMock: vi.fn(),
}))

vi.mock('../probe/disk-probe', () => ({
  probePrecise: probePreciseMock,
}))

// checkPort uses node:net I/O which doesn't fire under fake timers, and
// a live aria2 on the dev port would make it return false. Mock the
// port-check module so the supervisor always sees the port as available.
vi.mock('./port-check', () => ({
  checkPort: vi.fn().mockResolvedValue(true),
  findAvailablePort: vi.fn().mockResolvedValue(16801),
}))

// ─── Mock factories ─────────────────────────────────────────

const FEATURE_REPORT: EngineFeatureReport = {
  version: '1.37.0',
  features: ['Async DNS', 'BitTorrent', 'SQLite3-Persistence'],
  hasSqlitePersistence: true,
  hasBtSeedUnverified: false,
  hasBtSaveMetadata: false,
  hasMoveStorage: false,
}

function createMockSettingsManager(): SettingsManager {
  return {
    getEngine: vi.fn(() => ({
      rpcPort: 16800,
      rpcSecret: 'test-secret',
      dhtEnabled: true,
      listenPort: 6881,
      dhtListenPort: 6881,
      performanceProfile: 'auto',
      maxConcurrentDownloads: 5,
      maxConnectionPerServer: 64,
      split: 16,
      minSplitSize: 4194304,
      userAgent: 'Motrix/2.0',
      sessionSaveInterval: 60,
      fileAllocation: 'none',
      diskCache: 33554432,
    })),
    getApp: vi.fn(() => ({
      defaultSaveDir: '/Users/test/Downloads',
    })),
    getProxy: vi.fn(() => ({
      enabled: false,
      protocol: 'http',
      host: '',
      port: 8080,
      user: '',
      password: '',
      bypass: [],
      scopes: { download: false, updateApp: false, updateTrackers: false },
    })),
    update: vi.fn().mockResolvedValue(undefined),
  } as unknown as SettingsManager
}

function createMockProcessManager(): Aria2ProcessManager {
  return {
    probe: vi.fn().mockResolvedValue(FEATURE_REPORT),
    spawn: vi.fn().mockResolvedValue(undefined),
    gracefulStop: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn(),
    isRunning: vi.fn(() => true),
    getPid: vi.fn(() => 12345),
    inspectPort: vi.fn().mockResolvedValue(null),
    forceTerminateVerified: vi.fn().mockResolvedValue(undefined),
    onExit: null,
    onError: null,
  } as unknown as Aria2ProcessManager
}

function createMockConfigBuilder(): Aria2ConfigBuilder {
  return {
    ensureUserConfig: vi.fn().mockResolvedValue('/tmp/aria2.conf'),
    buildArgs: vi.fn(() => ['--conf-path=/tmp/aria2.conf']),
  } as unknown as Aria2ConfigBuilder
}

function createMockRpcClient(): Aria2RpcClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
    getVersion: vi.fn().mockResolvedValue({
      version: '1.37.0',
      enabledFeatures: ['SQLite3-Persistence'],
    }),
    saveSession: vi.fn().mockResolvedValue('OK'),
    shutdown: vi.fn().mockResolvedValue('OK'),
    changeGlobalOption: vi.fn().mockResolvedValue('OK'),
  } as unknown as Aria2RpcClient
}

function createMockTrustStore(): Aria2TrustStore {
  return {
    prepareEnvironment: vi.fn().mockResolvedValue(undefined),
  } as unknown as Aria2TrustStore
}

function createMockAdapter(): Aria2Adapter {
  return {
    setFeatureReport: vi.fn(),
  } as unknown as Aria2Adapter
}

// ─── Tests ──────────────────────────────────────────────────

describe('EngineSupervisor', () => {
  let eventBus: EventBus
  let settings: SettingsManager
  let processManager: Aria2ProcessManager
  let configBuilder: Aria2ConfigBuilder
  let trustStore: Aria2TrustStore
  let rpcClient: Aria2RpcClient
  let adapter: Aria2Adapter
  let supervisor: EngineSupervisor

  beforeEach(() => {
    vi.useFakeTimers()
    probePreciseMock.mockReset()
    probePreciseMock.mockResolvedValue({
      platform: 'darwin',
      mountPoint: '/',
      fsType: 'apfs',
      diskType: 'ssd',
      isInternal: true,
      isNetworkFs: false,
      freeBytes: 100 * 1024 * 1024 * 1024,
      confidence: 'high',
    })
    eventBus = new EventBus()
    settings = createMockSettingsManager()
    processManager = createMockProcessManager()
    configBuilder = createMockConfigBuilder()
    trustStore = createMockTrustStore()
    rpcClient = createMockRpcClient()
    adapter = createMockAdapter()

    supervisor = new EngineSupervisor(
      eventBus,
      settings,
      processManager,
      configBuilder,
      trustStore,
      rpcClient,
      adapter
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('initial state', () => {
    it('starts in Stopped state', () => {
      expect(supervisor.getState()).toBe(EngineState.Stopped)
    })
  })

  describe('start — happy path', () => {
    it('transitions Stopped → Starting → Ready', async () => {
      const states: EngineState[] = []
      eventBus.on(Events.EngineStateChanged, (state) => {
        states.push(state as EngineState)
      })

      await supervisor.start('/usr/bin/aria2c')

      expect(states).toEqual([EngineState.Starting, EngineState.Ready])
      expect(supervisor.getState()).toBe(EngineState.Ready)
    })

    it('calls probe → ensureConfig → buildArgs → spawn → connect', async () => {
      await supervisor.start('/usr/bin/aria2c')

      expect(processManager.probe).toHaveBeenCalledWith('/usr/bin/aria2c')
      expect(configBuilder.ensureUserConfig).toHaveBeenCalled()
      expect(trustStore.prepareEnvironment).toHaveBeenCalled()
      expect(configBuilder.buildArgs).toHaveBeenCalled()
      expect(processManager.spawn).toHaveBeenCalledWith(
        '/usr/bin/aria2c',
        ['--conf-path=/tmp/aria2.conf'],
        undefined
      )
      expect(rpcClient.connect).toHaveBeenCalledWith(16800)
    })

    it('passes the prepared trust environment only to the aria2 process', async () => {
      const env = {
        PATH: '/usr/bin',
        SSL_CERT_FILE: '/tmp/aria2-ca-bundle.pem',
      }
      vi.mocked(trustStore.prepareEnvironment).mockResolvedValue(env)

      await supervisor.start('/usr/bin/aria2c')

      expect(processManager.spawn).toHaveBeenCalledWith(
        '/usr/bin/aria2c',
        ['--conf-path=/tmp/aria2.conf'],
        env
      )
    })

    it('caches feature report after successful start', async () => {
      await supervisor.start('/usr/bin/aria2c')
      expect(supervisor.getFeatureReport()).toEqual(FEATURE_REPORT)
    })

    it('injects the probed feature report into the adapter before Ready', async () => {
      // The adapter's durable-remove trust gate reads its OWN featureReport.
      // Nothing in production calls adapter.connect(), so the supervisor must
      // inject the report it already probed — otherwise the adapter keeps its
      // default (version unknown, no persistence) and the gate silently
      // degrades to "always trust not-found".
      await supervisor.start('/usr/bin/aria2c')
      expect(adapter.setFeatureReport).toHaveBeenCalledWith(FEATURE_REPORT)
    })

    it('does not overwrite persisted tuning settings during engine start', async () => {
      await supervisor.start('/usr/bin/aria2c')
      expect(settings.update).not.toHaveBeenCalled()
    })

    it('applies automatic storage tuning to runtime args', async () => {
      probePreciseMock.mockResolvedValue({
        platform: 'linux',
        mountPoint: '/downloads',
        fsType: 'ext4',
        diskType: 'hdd',
        isInternal: true,
        isNetworkFs: false,
        freeBytes: 100 * 1024 * 1024 * 1024,
        confidence: 'high',
      })

      await supervisor.start('/usr/bin/aria2c')

      expect(configBuilder.buildArgs).toHaveBeenCalledWith(
        expect.objectContaining({
          performanceProfile: 'auto',
          diskCache: 64 * 1024 * 1024,
          split: 8,
          minSplitSize: 20 * 1024 * 1024,
        }),
        expect.anything(),
        expect.anything(),
        expect.anything()
      )
      expect(settings.update).not.toHaveBeenCalled()
    })

    it('keeps custom performance values unchanged at runtime', async () => {
      const configured = settings.getEngine()
      vi.mocked(settings.getEngine).mockReturnValue({
        ...configured,
        performanceProfile: 'custom',
        diskCache: 48 * 1024 * 1024,
        split: 24,
        minSplitSize: 2 * 1024 * 1024,
      })

      await supervisor.start('/usr/bin/aria2c')

      expect(probePreciseMock).not.toHaveBeenCalled()
      expect(configBuilder.buildArgs).toHaveBeenCalledWith(
        expect.objectContaining({
          performanceProfile: 'custom',
          diskCache: 48 * 1024 * 1024,
          split: 24,
          minSplitSize: 2 * 1024 * 1024,
        }),
        expect.anything(),
        expect.anything(),
        expect.anything()
      )
    })
  })

  describe('start — probe failure', () => {
    it('transitions to Failed when probe rejects', async () => {
      vi.mocked(processManager.probe).mockRejectedValue(
        new Error('Binary not found')
      )

      await supervisor.start('/bad/path')

      expect(supervisor.getState()).toBe(EngineState.Failed)
    })
  })

  describe('start — spawn failure', () => {
    it('transitions to Failed when spawn rejects', async () => {
      vi.mocked(processManager.spawn).mockRejectedValue(new Error('ENOENT'))

      await supervisor.start('/usr/bin/aria2c')

      expect(supervisor.getState()).toBe(EngineState.Failed)
    })
  })

  describe('start — RPC connect failure', () => {
    it('transitions to Failed when RPC connect rejects', async () => {
      vi.mocked(rpcClient.connect).mockRejectedValue(
        new Error('Connection refused')
      )

      await supervisor.start('/usr/bin/aria2c')

      expect(supervisor.getState()).toBe(EngineState.Failed)
      expect(processManager.gracefulStop).toHaveBeenCalledWith(5_000)
      expect(rpcClient.disconnect).toHaveBeenCalled()
    })
  })

  describe('stop', () => {
    it('on stop: SIGTERMs aria2 with 30s graceful timeout, no RPC chatter', async () => {
      await supervisor.start('/usr/bin/aria2c')

      await supervisor.stop()

      expect(rpcClient.saveSession).not.toHaveBeenCalled()
      expect(rpcClient.shutdown).not.toHaveBeenCalled()
      expect(processManager.gracefulStop).toHaveBeenCalledWith(30_000)
      expect(supervisor.getState()).toBe(EngineState.Stopped)
    })

    it('emits EngineStateChanged(Stopped)', async () => {
      await supervisor.start('/usr/bin/aria2c')

      const states: EngineState[] = []
      eventBus.on(Events.EngineStateChanged, (state) => {
        states.push(state as EngineState)
      })

      await supervisor.stop()

      expect(states).toContain(EngineState.Stopped)
    })

    it('is safe to call when already stopped', async () => {
      await supervisor.stop()
      expect(supervisor.getState()).toBe(EngineState.Stopped)
    })

    it('stops a tracked aria2 process even when state is Failed', async () => {
      vi.mocked(processManager.probe).mockRejectedValue(
        new Error('Binary not found')
      )
      await supervisor.start('/bad/path')
      vi.mocked(processManager.gracefulStop).mockClear()

      await supervisor.stop()

      expect(processManager.gracefulStop).toHaveBeenCalledWith(30_000)
      expect(supervisor.getState()).toBe(EngineState.Stopped)
    })
  })

  describe('health check', () => {
    it('calls getVersion every 30s when Ready', async () => {
      await supervisor.start('/usr/bin/aria2c')
      vi.mocked(rpcClient.getVersion).mockClear()

      // Advance past heartbeat interval
      await vi.advanceTimersByTimeAsync(30_000)
      expect(rpcClient.getVersion).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(30_000)
      expect(rpcClient.getVersion).toHaveBeenCalledTimes(2)
    })

    it('triggers restart after 3 consecutive heartbeat failures', async () => {
      await supervisor.start('/usr/bin/aria2c')
      vi.mocked(rpcClient.getVersion).mockRejectedValue(new Error('Timeout'))

      const states: EngineState[] = []
      eventBus.on(Events.EngineStateChanged, (state) => {
        states.push(state as EngineState)
      })

      // 3 consecutive failures at 30s intervals
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.advanceTimersByTimeAsync(30_000)

      expect(states).toContain(EngineState.Restarting)
    })

    it('resets failure counter on successful heartbeat', async () => {
      await supervisor.start('/usr/bin/aria2c')

      // 2 failures
      vi.mocked(rpcClient.getVersion).mockRejectedValueOnce(
        new Error('Timeout')
      )
      vi.mocked(rpcClient.getVersion).mockRejectedValueOnce(
        new Error('Timeout')
      )
      // Then success
      vi.mocked(rpcClient.getVersion).mockResolvedValueOnce({
        version: '1.37.0',
        enabledFeatures: [],
      })

      await vi.advanceTimersByTimeAsync(30_000) // fail 1
      await vi.advanceTimersByTimeAsync(30_000) // fail 2
      await vi.advanceTimersByTimeAsync(30_000) // success — resets counter

      expect(supervisor.getState()).toBe(EngineState.Ready)
    })
  })

  describe('restart with backoff', () => {
    it('uses exponential backoff delays', async () => {
      await supervisor.start('/usr/bin/aria2c')

      // Trigger restart by simulating process exit
      const onExit = vi.mocked(processManager).onExit
      expect(onExit).not.toBeNull()

      // We need to verify the supervisor transitions to Restarting
      // and then attempts restart after backoff delay
      const states: EngineState[] = []
      eventBus.on(Events.EngineStateChanged, (state) => {
        states.push(state as EngineState)
      })

      // Simulate process unexpected exit
      if (processManager.onExit) {
        processManager.onExit(1, null)
      }

      expect(states).toContain(EngineState.Restarting)
    })

    it('transitions to Failed after MAX_RESTARTS', async () => {
      await supervisor.start('/usr/bin/aria2c')

      // Make all restart attempts fail
      vi.mocked(processManager.spawn).mockRejectedValue(
        new Error('Spawn failed')
      )

      const states: EngineState[] = []
      eventBus.on(Events.EngineStateChanged, (state) => {
        states.push(state as EngineState)
      })

      // Trigger restart
      if (processManager.onExit) {
        processManager.onExit(1, null)
      }

      // Advance through all 5 restart attempts with their backoff
      // delays: 1s, 2s, 4s, 8s, 16s = 31s total
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(30_000)
      }

      expect(states).toContain(EngineState.Failed)
    })
  })

  describe('port check', () => {
    // Real port binding is an integration concern; checkPort is
    // mocked at the module boundary above.

    it('proceeds normally when port is available', async () => {
      // Default mock: no port conflict
      await supervisor.start('/usr/bin/aria2c')
      expect(supervisor.getState()).toBe(EngineState.Ready)
    })
  })

  describe('restart (manual composite)', () => {
    it('stops then starts using the previously-recorded binary path', async () => {
      // Drive the supervisor through a successful start so binaryPath is set.
      await supervisor.start('/usr/bin/aria2c')
      expect(supervisor.getState()).toBe(EngineState.Ready)

      const stopSpy = vi.spyOn(supervisor, 'stop')
      const startSpy = vi.spyOn(supervisor, 'start')

      await supervisor.restart()

      expect(stopSpy).toHaveBeenCalledOnce()
      expect(startSpy).toHaveBeenCalledOnce()
      expect(startSpy).toHaveBeenCalledWith('/usr/bin/aria2c')
      // stop must run before start
      expect(stopSpy.mock.invocationCallOrder[0]).toBeLessThan(
        startSpy.mock.invocationCallOrder[0]
      )
    })

    it('throws if called before start (no binary path stored)', async () => {
      // Fresh supervisor that has never been started — binaryPath is null.
      await expect(supervisor.restart()).rejects.toThrow(
        'EngineSupervisor.restart called before start'
      )
    })
  })

  describe('EngineFailureOccurred', () => {
    function collectFailures(): EngineFailurePayload[] {
      const payloads: EngineFailurePayload[] = []
      eventBus.on(Events.EngineFailureOccurred, (payload) => {
        payloads.push(payload as EngineFailurePayload)
      })
      return payloads
    }

    it('emits exactly once on a cold-start spawn failure, with reason and a fresh incidentId', async () => {
      vi.mocked(processManager.spawn).mockRejectedValue(new Error('ENOENT'))
      const payloads = collectFailures()

      await supervisor.start('/usr/bin/aria2c')

      expect(supervisor.getState()).toBe(EngineState.Failed)
      expect(payloads).toHaveLength(1)
      expect(payloads[0]).toMatchObject({
        reason: EngineFailureReason.SpawnFailed,
        technicalMessage: 'ENOENT',
      })
      expect(payloads[0].incidentId).toMatch(/^engine:\d+:\d+$/)
      expect(typeof payloads[0].occurredAt).toBe('number')
    })

    it('stop() emits EngineDisconnected but never EngineFailureOccurred', async () => {
      await supervisor.start('/usr/bin/aria2c')
      const payloads = collectFailures()
      const disconnected = vi.fn()
      eventBus.on(Events.EngineDisconnected, disconnected)

      await supervisor.stop()

      expect(disconnected).toHaveBeenCalledOnce()
      expect(payloads).toHaveLength(0)
    })

    it('suppresses a process exit as soon as app shutdown is prepared', async () => {
      await supervisor.start('/usr/bin/aria2c')
      const payloads = collectFailures()

      supervisor.prepareForShutdown()
      processManager.onExit?.(1, null)

      expect(payloads).toHaveLength(0)
      expect(supervisor.getState()).toBe(EngineState.Ready)
      await supervisor.stop()
    })

    it('restart() emits no EngineFailureOccurred on a successful manual restart', async () => {
      await supervisor.start('/usr/bin/aria2c')
      const payloads = collectFailures()

      await supervisor.restart()

      expect(supervisor.getState()).toBe(EngineState.Ready)
      expect(payloads).toHaveLength(0)
    })

    it('assigns two distinct incidentIds across two consecutive cold-start failures', async () => {
      vi.mocked(processManager.spawn).mockRejectedValue(new Error('ENOENT'))
      const payloads = collectFailures()

      await supervisor.start('/usr/bin/aria2c')
      await supervisor.start('/usr/bin/aria2c')

      expect(payloads).toHaveLength(2)
      expect(payloads[0].incidentId).not.toBe(payloads[1].incidentId)
    })

    describe('cold-start delivery to the notification center', () => {
      // Regression pin for the bootstrap-ordering bug: both shells used to
      // wire registerEngineFailureSubscriber() only after a successful
      // supervisor.start() (gated behind the Ready-state check), so a
      // failure on the very first boot — the case this feature exists
      // for — emitted with no subscriber listening and the notification
      // was silently dropped. The fix hoists the NotificationCenter +
      // registerEngineFailureSubscriber() construction to run BEFORE
      // supervisor.start() in both src/main/index.ts and
      // src/server/index.ts. This test reproduces that exact ordering
      // end-to-end against a real in-memory MotrixDatabase, so reverting
      // the bootstrap order (or the subscriber wiring) fails here first.
      let db: MotrixDatabase

      beforeEach(() => {
        db = new MotrixDatabase(':memory:')
        db.init()
      })

      afterEach(() => {
        db.close()
      })

      it('delivers a notification row for a failure on the very first cold start', async () => {
        const center = new NotificationCenter({
          store: db,
          emit: eventBus.emit.bind(eventBus),
          log: { warn: vi.fn(), error: vi.fn() },
        })
        // Subscriber wired BEFORE start() — mirrors the fixed bootstrap
        // order, not the pre-fix order (wired only after a Ready check).
        registerEngineFailureSubscriber({
          motrixDb: db,
          eventBus,
          notificationCenter: center,
          log: { warn: vi.fn() },
        })
        vi.mocked(processManager.spawn).mockRejectedValue(new Error('ENOENT'))

        await supervisor.start('/usr/bin/aria2c')

        expect(supervisor.getState()).toBe(EngineState.Failed)
        const rows = center.list()
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({
          kind: NotificationKinds.EngineFailure,
          severity: 'error',
          titleKey: 'notification.engineFailure.title',
          bodyKey: 'panel.dashboard.engine.diagnostics.reason.spawn_failed',
          taskId: null,
        })
      })

      it('a throwing store write inside the notification subscriber never blocks recordFailure() from completing its own state transition', async () => {
        // Regression pin for the isolation fix in
        // engine-failure-subscriber.ts: notify()'s store write
        // (insertNotificationWithLedger) can throw (SQLITE_FULL etc.).
        // EventBus.emit has no per-listener isolation, so a subscriber
        // throw used to unwind straight through
        // EngineSupervisor.recordFailure() and abort the caller's own
        // setState(Failed) transition. Same cold-start wiring order as
        // the test above, but with a store whose write always throws.
        const throwingStore = {
          deleteEngineNotificationLedgerBefore: vi.fn(() => 0),
          insertNotificationWithLedger: vi.fn(() => {
            throw new Error('SQLITE_FULL')
          }),
        } as unknown as MotrixDatabase
        const log = { warn: vi.fn(), error: vi.fn() }
        const center = new NotificationCenter({
          store: throwingStore,
          emit: eventBus.emit.bind(eventBus),
          log,
        })
        registerEngineFailureSubscriber({
          motrixDb: throwingStore,
          eventBus,
          notificationCenter: center,
          log,
        })
        vi.mocked(processManager.spawn).mockRejectedValue(new Error('ENOENT'))

        await supervisor.start('/usr/bin/aria2c')

        expect(supervisor.getState()).toBe(EngineState.Failed)
        expect(log.warn).toHaveBeenCalledOnce()
      })
    })
  })

  describe('manual recovery', () => {
    function useFallbackPort(): { rpcPort: number } {
      const engineSettings = {
        ...settings.getEngine(),
        rpcPort: 16801,
      }
      vi.mocked(settings.getEngine).mockImplementation(() => engineSettings)
      vi.mocked(settings.update).mockImplementation(async (patch) => {
        if (typeof patch.engine?.rpcPort === 'number') {
          engineSettings.rpcPort = patch.engine.rpcPort
        }
        return undefined as never
      })
      return engineSettings
    }

    it('revalidates the pid before force stopping and restarts on the same port', async () => {
      await supervisor.start('/usr/bin/aria2c')

      const result = await supervisor.recover({
        action: EngineRecoveryAction.ForceTerminate,
        expectedPid: 4321,
      })

      expect(processManager.forceTerminateVerified).toHaveBeenCalledWith(
        4321,
        16800,
        expect.objectContaining({ binaryPath: '/usr/bin/aria2c' })
      )
      expect(result).toMatchObject({
        ok: true,
        previousRpcPort: 16800,
        rpcPort: 16800,
      })
    })

    it('persists and restarts on port 16800 when restoring a free default port', async () => {
      useFallbackPort()
      await supervisor.start('/usr/bin/aria2c')

      const result = await supervisor.recover({
        action: EngineRecoveryAction.RestoreDefaultPort,
      })

      expect(settings.update).toHaveBeenCalledWith({
        engine: { rpcPort: 16800 },
      })
      expect(result).toMatchObject({
        ok: true,
        previousRpcPort: 16801,
        rpcPort: 16800,
      })
    })

    it('revalidates and stops a verified orphan before restoring port 16800', async () => {
      useFallbackPort()
      let defaultPortAvailable = false
      vi.mocked(checkPort).mockImplementation(async (port) =>
        port === 16800 ? defaultPortAvailable : true
      )
      vi.mocked(processManager.inspectPort).mockResolvedValue({
        pid: 4321,
        name: 'aria2c',
        executableName: 'aria2c',
        ownership: EngineProcessOwnership.VerifiedOrphan,
        safeToTerminate: true,
      })
      vi.mocked(processManager.forceTerminateVerified).mockImplementation(
        async () => {
          defaultPortAvailable = true
        }
      )
      await supervisor.start('/usr/bin/aria2c')

      const result = await supervisor.recover({
        action: EngineRecoveryAction.RestoreDefaultPort,
        expectedPid: 4321,
      })

      expect(processManager.forceTerminateVerified).toHaveBeenCalledWith(
        4321,
        16800,
        expect.objectContaining({ binaryPath: '/usr/bin/aria2c' })
      )
      expect(settings.update).toHaveBeenCalledWith({
        engine: { rpcPort: 16800 },
      })
      expect(result.rpcPort).toBe(16800)
    })

    it('protects an unverified process using the default port', async () => {
      useFallbackPort()
      vi.mocked(checkPort).mockImplementation(async (port) => port !== 16800)
      vi.mocked(processManager.inspectPort).mockResolvedValue({
        pid: 4321,
        name: 'aria2c',
        executableName: 'aria2c',
        ownership: EngineProcessOwnership.ExternalAria2,
        safeToTerminate: false,
      })
      await supervisor.start('/usr/bin/aria2c')

      await expect(
        supervisor.recover({
          action: EngineRecoveryAction.RestoreDefaultPort,
          expectedPid: 4321,
        })
      ).rejects.toMatchObject({
        code: ErrorCode.EngineProcessOwnershipUnverified,
      })
      expect(processManager.forceTerminateVerified).not.toHaveBeenCalled()
      expect(settings.update).not.toHaveBeenCalled()
    })

    it('reports whether a fallback session can safely restore port 16800', async () => {
      useFallbackPort()
      vi.mocked(checkPort).mockImplementation(async (port) => port === 16800)
      await supervisor.start('/usr/bin/aria2c')

      const report = await supervisor.diagnose()

      expect(report.rpc.port).toBe(16801)
      expect(report.defaultRpc).toEqual({
        port: 16800,
        isCurrent: false,
        available: true,
        process: null,
        canRestore: true,
        requiresTermination: false,
      })
    })
  })

  describe('applyAsyncDns', () => {
    it('is a no-op unless Ready', async () => {
      await supervisor.applyAsyncDns(false)
      expect(rpcClient.changeGlobalOption).not.toHaveBeenCalled()
    })

    it.each([
      [false, 'false'],
      [true, 'true'],
    ] as const)(
      'calls changeGlobalOption with async-dns=%s when Ready',
      async (asyncDns, wire) => {
        await supervisor.start('/usr/bin/aria2c')
        vi.mocked(rpcClient.changeGlobalOption).mockClear()
        await supervisor.applyAsyncDns(asyncDns)
        expect(rpcClient.changeGlobalOption).toHaveBeenCalledWith({
          'async-dns': wire,
        })
      }
    )
  })

  describe('applySpeedLimits', () => {
    it('is a no-op unless Ready', async () => {
      await supervisor.applySpeedLimits({ download: 100, upload: 50 })
      expect(rpcClient.changeGlobalOption).not.toHaveBeenCalled()
    })

    it('calls changeGlobalOption with string values when Ready', async () => {
      await supervisor.start('/usr/bin/aria2c')
      vi.mocked(rpcClient.changeGlobalOption).mockClear()
      await supervisor.applySpeedLimits({ download: 100, upload: 50 })
      expect(rpcClient.changeGlobalOption).toHaveBeenCalledWith({
        'max-overall-download-limit': '100',
        'max-overall-upload-limit': '50',
      })
    })

    it('passes effective limits from provider to buildArgs', async () => {
      supervisor.setEffectiveLimitsProvider(() => ({
        download: 500,
        upload: 250,
      }))
      await supervisor.start('/usr/bin/aria2c')
      expect(configBuilder.buildArgs).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        { download: 500, upload: 250 }
      )
    })

    it('passes 0/0 limits to buildArgs when no provider is registered', async () => {
      // no setEffectiveLimitsProvider call
      await supervisor.start('/usr/bin/aria2c')
      expect(configBuilder.buildArgs).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        { download: 0, upload: 0 }
      )
    })
  })

  describe('applyEngineSettings', () => {
    it('is a no-op unless Ready', async () => {
      const previous = settings.getEngine()
      await supervisor.applyEngineSettings(previous, {
        ...previous,
        split: 32,
      })
      expect(rpcClient.changeGlobalOption).not.toHaveBeenCalled()
    })

    it('maps changed runtime settings and excludes startup-only settings', async () => {
      await supervisor.start('/usr/bin/aria2c')
      vi.mocked(rpcClient.changeGlobalOption).mockClear()
      const previous = settings.getEngine()

      await supervisor.applyEngineSettings(previous, {
        ...previous,
        split: 32,
        userAgent: 'Motrix/Test',
        btEnableLpd: false,
        sessionSaveInterval: 30,
        fileAllocation: 'prealloc',
        diskCache: 32 * 1024 * 1024,
      })

      expect(rpcClient.changeGlobalOption).toHaveBeenCalledWith({
        split: '32',
        'user-agent': 'Motrix/Test',
        'bt-enable-lpd': 'false',
        'save-session-interval': '30',
      })
    })
  })

  describe('applyProxyChange', () => {
    it('is no-op when state is not Ready', async () => {
      // supervisor starts in Stopped — never started
      await supervisor.applyProxyChange({
        allProxy: 'http://p:80',
        noProxy: '',
      })
      expect(rpcClient.changeGlobalOption).not.toHaveBeenCalled()
    })

    it('sends all-proxy + no-proxy when ready and opts provided', async () => {
      await supervisor.start('/usr/bin/aria2c')
      await supervisor.applyProxyChange({
        allProxy: 'http://p:80',
        noProxy: 'localhost',
      })
      expect(rpcClient.changeGlobalOption).toHaveBeenCalledWith({
        'all-proxy': 'http://p:80',
        'no-proxy': 'localhost',
      })
    })

    it('clears proxy when opts is null', async () => {
      await supervisor.start('/usr/bin/aria2c')
      await supervisor.applyProxyChange(null)
      expect(rpcClient.changeGlobalOption).toHaveBeenCalledWith({
        'all-proxy': '',
        'no-proxy': '',
      })
    })
  })

  describe('waitUntilReady', () => {
    it('resolves immediately when the engine is already Ready', async () => {
      await supervisor.start('/usr/bin/aria2c') // drives Stopped → Starting → Ready
      expect(supervisor.getState()).toBe(EngineState.Ready)
      await expect(supervisor.waitUntilReady(15_000)).resolves.toBeUndefined()
    })

    it('resolves when a later EngineStateChanged → Ready fires', async () => {
      const p = supervisor.waitUntilReady(15_000) // state is Stopped → listens
      eventBus.emit(Events.EngineStateChanged, EngineState.Ready)
      await expect(p).resolves.toBeUndefined()
    })

    it('rejects with EngineTimeout when the engine goes Failed while waiting', async () => {
      const p = supervisor.waitUntilReady(15_000)
      eventBus.emit(Events.EngineStateChanged, EngineState.Failed)
      await expect(p).rejects.toMatchObject({ code: ErrorCode.EngineTimeout })
    })

    it('rejects with EngineTimeout after the timeout elapses', async () => {
      const p = supervisor.waitUntilReady(100)
      const assertion = expect(p).rejects.toMatchObject({
        code: ErrorCode.EngineTimeout,
      })
      await vi.advanceTimersByTimeAsync(100)
      await assertion
    })

    it('removes its EngineStateChanged listener on settle (no leak)', async () => {
      const offSpy = vi.spyOn(eventBus, 'off')
      const p = supervisor.waitUntilReady(15_000)
      eventBus.emit(Events.EngineStateChanged, EngineState.Ready)
      await p
      expect(offSpy).toHaveBeenCalledWith(
        Events.EngineStateChanged,
        expect.any(Function)
      )
    })
  })
})
