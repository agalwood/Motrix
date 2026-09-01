import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BRIDGE_DATA_DIR_LOCK_FILE_NAME } from '@core/bridge/bridge-data-dir-lock'
import { Mbp1CredentialStore } from '@core/bridge/credential-store'
import { EndpointFileWriter } from '@core/bridge/endpoint-file-writer'
import type { PairDialogRequest } from '@core/bridge/mbp1/pair-session'
import type { PairingPromptEnqueueResult } from '@core/bridge/pairing-prompt-controller'
import { PairingService } from '@core/bridge/pairing-service'
import { WebSocketBridgeServer } from '@core/bridge/web-socket-bridge-server'
import { BridgeReceiver } from '@core/bridge-receiver/bridge-receiver'
import { BridgeStreamSource } from '@core/bridge-receiver/bridge-stream-source'
import type { BridgeStatusInfo } from '@shared/protocol/bridge'
import { EngineState } from '@shared/types/engine'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeMessagingInstaller } from './native-messaging-installer'

const electron = vi.hoisted(() => ({
  userDataDir: '',
  isPackaged: false,
  handle: vi.fn(),
  removeHandler: vi.fn(),
}))
const snapRuntime = vi.hoisted(() => ({
  enabled: false,
  instanceName: 'motrix_work',
}))

vi.mock('./snap-environment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./snap-environment')>()
  return {
    ...actual,
    resolvePackagedLinuxSnapEnvironment: (
      options: Parameters<typeof actual.resolvePackagedLinuxSnapEnvironment>[0]
    ) =>
      snapRuntime.enabled
        ? {
            installRoot: '/snap/motrix/current',
            realHome: electron.userDataDir,
            instanceName: snapRuntime.instanceName,
          }
        : actual.resolvePackagedLinuxSnapEnvironment(options),
  }
})

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged
    },
    getPath: () => electron.userDataDir,
  },
  ipcMain: {
    handle: (...args: unknown[]) => electron.handle(...args),
    removeHandler: (...args: unknown[]) => electron.removeHandler(...args),
  },
}))

vi.mock('../ipc/trusted-ipc', () => ({
  registerTrustedIpcHandler: (
    channel: string,
    listener: (...args: unknown[]) => unknown
  ) => electron.handle(channel, listener),
}))

import { bootstrapBridge } from './index'

function args(): Parameters<typeof bootstrapBridge>[0] {
  return {
    getMainWindow: () => null,
    motrixVersion: '2.0-test',
    ffmpegAvailable: false,
    enabled: true,
    bridgeSettings: { fixedPort: 'auto', instanceId: 'test-instance-id' },
    bridgeDataDirLockRecoveryAuthority: {
      ownershipEpoch: 'T'.repeat(43),
      assertExclusiveProcessOwnership: () => true,
    },
    eventBus: { on: vi.fn(), off: vi.fn() },
    createTaskDeps: {} as never,
    activityRecorder: {} as never,
    publishTaskUpdate: vi.fn(),
    publishTaskUpdateNow: vi.fn(),
    removeTask: vi.fn(async () => {}),
    submitMagnetForFileSelection: vi.fn(async () => 'magnet'),
    isMagnetFileSelectionEnabled: vi.fn(() => false),
    finalNamePicker: { pick: vi.fn(async (_dir, desired) => desired) },
    defaultSaveDir: '/downloads',
    readHandlerDeps: {
      taskManager: { getAll: () => [], getById: () => undefined },
      statsAggregator: {
        getStats: () => ({
          totalDownloadSpeed: 0,
          totalUploadSpeed: 0,
          activeTasks: 0,
          waitingTasks: 0,
          stoppedTasks: 0,
        }),
      },
      supervisor: {
        getState: () => EngineState.Ready,
        getFeatureReport: () => null,
      },
    },
    writeHandlerDeps: {
      taskManager: { getById: () => undefined },
      pauseTask: vi.fn(async () => {}),
      resumeTask: vi.fn(async () => {}),
      removeTask: vi.fn(async () => {}),
      createTask: vi.fn(async () => ({ taskId: 'created' })),
      parseTorrentFileCount: vi.fn(async () => 1),
    },
    ffmpegBinaryPath: null,
    taskManager: {} as never,
    segmentAria2: {} as never,
    tmpRoot: '/tmp/media',
    persistTask: vi.fn(async () => {}),
    parentTaskCreated: vi.fn(async (_task, persist) => persist()),
    recordTransition: vi.fn(async () => {}),
    runTaskMutation: async (_taskIds, operation) => operation(),
    trackAsyncWork: (operation) => operation(),
    pluginRegistry: { entries: () => [] } as never,
    pluginHost: {} as never,
  }
}

describe('desktop bridge bootstrap ownership', () => {
  let userDataDir: string
  const activeChannels = new Set<string>()

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'motrix-desktop-bridge-'))
    electron.userDataDir = userDataDir
    electron.isPackaged = false
    snapRuntime.enabled = false
    snapRuntime.instanceName = 'motrix_work'
    activeChannels.clear()
    electron.handle.mockReset()
    electron.removeHandler.mockReset()
    electron.handle.mockImplementation((channel: string) => {
      if (activeChannels.has(channel)) {
        throw new Error(`duplicate handler: ${channel}`)
      }
      activeChannels.add(channel)
    })
    electron.removeHandler.mockImplementation((channel: string) => {
      activeChannels.delete(channel)
    })
    vi.spyOn(BridgeReceiver.prototype, 'restoreInflight').mockResolvedValue()
    vi.spyOn(BridgeReceiver.prototype, 'start').mockImplementation(() => {})
    vi.spyOn(BridgeReceiver.prototype, 'stopAndDrain').mockResolvedValue()
    vi.spyOn(
      WebSocketBridgeServer.prototype,
      'startOnFirstFree'
    ).mockResolvedValue({ port: 19002, degraded: false })
    vi.spyOn(WebSocketBridgeServer.prototype, 'stop').mockResolvedValue()
    vi.spyOn(PairingService.prototype, 'stopAndDrain').mockResolvedValue()
    vi.spyOn(BridgeStreamSource.prototype, 'attach').mockImplementation(
      () => {}
    )
    vi.spyOn(BridgeStreamSource.prototype, 'detach').mockImplementation(
      () => {}
    )
    vi.spyOn(
      NativeMessagingInstaller.prototype,
      'syncManifests'
    ).mockResolvedValue()
    vi.spyOn(
      NativeMessagingInstaller.prototype,
      'unregister'
    ).mockResolvedValue()
    vi.spyOn(EndpointFileWriter.prototype, 'write').mockResolvedValue()
    vi.spyOn(EndpointFileWriter.prototype, 'clear').mockResolvedValue()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(userDataDir, { recursive: true, force: true })
  })

  it('acquires the data-root lock before the first bridge store load', async () => {
    const lockPath = join(userDataDir, 'bridge', BRIDGE_DATA_DIR_LOCK_FILE_NAME)
    const load = vi.spyOn(PairingService.prototype, 'load')
    load.mockImplementationOnce(async () => {
      const document = JSON.parse(await readFile(lockPath, 'utf-8')) as {
        ownershipEpoch?: unknown
      }
      expect(document.ownershipEpoch).toBe('T'.repeat(43))
    })

    const runtime = await bootstrapBridge(args())
    expect(runtime).not.toBeNull()
    await runtime?.shutdown()
  })

  it('holds the data-root lock through listener and store drain, then releases it', async () => {
    const lockPath = join(userDataDir, 'bridge', BRIDGE_DATA_DIR_LOCK_FILE_NAME)
    vi.mocked(WebSocketBridgeServer.prototype.stop).mockImplementation(
      async () => {
        expect((await lstat(lockPath)).isFile()).toBe(true)
      }
    )
    vi.mocked(PairingService.prototype.stopAndDrain).mockImplementation(
      async () => {
        expect((await lstat(lockPath)).isFile()).toBe(true)
      }
    )

    const runtime = await bootstrapBridge(args())
    await runtime?.shutdown()

    await expect(lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('releases the data-root lock when the first store load fails', async () => {
    const failure = new Error('pairing store unavailable')
    vi.spyOn(PairingService.prototype, 'load').mockRejectedValueOnce(failure)
    const lockPath = join(userDataDir, 'bridge', BRIDGE_DATA_DIR_LOCK_FILE_NAME)

    await expect(bootstrapBridge(args())).rejects.toBe(failure)
    await expect(lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(
      WebSocketBridgeServer.prototype.startOnFirstFree
    ).not.toHaveBeenCalled()
  })

  it.runIf(process.platform !== 'win32')(
    'repairs a projection writer residue before loading any bridge store',
    async () => {
      const bridgeDirectory = join(userDataDir, 'bridge')
      await mkdir(bridgeDirectory, { recursive: true })
      const projectionLock = join(
        bridgeDirectory,
        'extension-pairings.json.lock'
      )
      await writeFile(projectionLock, 'crashed writer', { mode: 0o600 })

      const runtime = await bootstrapBridge(args())
      expect(runtime).not.toBeNull()
      await expect(lstat(projectionLock)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await runtime?.shutdown()
    }
  )

  it.runIf(process.platform !== 'win32')(
    'keeps listeners closed when a projection residue is not a regular owned file',
    async () => {
      const bridgeDirectory = join(userDataDir, 'bridge')
      await mkdir(bridgeDirectory, { recursive: true })
      const target = join(userDataDir, 'do-not-remove')
      const projectionLock = join(
        bridgeDirectory,
        'extension-pairings.json.lock'
      )
      await writeFile(target, 'preserved', { mode: 0o600 })
      await symlink(target, projectionLock)

      await expect(bootstrapBridge(args())).rejects.toThrow(
        'extension-pairing-projection file rejected'
      )
      expect(
        WebSocketBridgeServer.prototype.startOnFirstFree
      ).not.toHaveBeenCalled()
      await expect(readFile(target, 'utf-8')).resolves.toBe('preserved')
      expect((await lstat(projectionLock)).isSymbolicLink()).toBe(true)
    }
  )

  it('drains receiver work published before restore rejects', async () => {
    const failure = new Error('receiver restore failed after resume')
    let receiverLive = false
    vi.mocked(BridgeReceiver.prototype.restoreInflight).mockImplementationOnce(
      async () => {
        receiverLive = true
        throw failure
      }
    )
    vi.mocked(BridgeReceiver.prototype.stopAndDrain).mockImplementationOnce(
      async () => {
        receiverLive = false
      }
    )

    await expect(bootstrapBridge(args())).rejects.toBe(failure)

    expect(receiverLive).toBe(false)
    expect(BridgeReceiver.prototype.stopAndDrain).toHaveBeenCalledOnce()
    expect(BridgeReceiver.prototype.start).not.toHaveBeenCalled()
  })

  it('drains a receiver whose start side effect throws', async () => {
    const failure = new Error('receiver start failed after subscribe')
    let receiverLive = false
    vi.mocked(BridgeReceiver.prototype.start).mockImplementationOnce(() => {
      receiverLive = true
      throw failure
    })
    vi.mocked(BridgeReceiver.prototype.stopAndDrain).mockImplementationOnce(
      async () => {
        receiverLive = false
      }
    )

    await expect(bootstrapBridge(args())).rejects.toBe(failure)

    expect(receiverLive).toBe(false)
    expect(BridgeReceiver.prototype.stopAndDrain).toHaveBeenCalledOnce()
    expect(
      WebSocketBridgeServer.prototype.startOnFirstFree
    ).not.toHaveBeenCalled()
  })

  it('detaches a stream whose attach side effect throws', async () => {
    const failure = new Error('stream attach failed after subscribe')
    let streamLive = false
    vi.mocked(BridgeStreamSource.prototype.attach).mockImplementationOnce(
      () => {
        streamLive = true
        throw failure
      }
    )
    vi.mocked(BridgeStreamSource.prototype.detach).mockImplementationOnce(
      () => {
        streamLive = false
      }
    )

    await expect(bootstrapBridge(args())).rejects.toBe(failure)

    expect(streamLive).toBe(false)
    expect(BridgeStreamSource.prototype.detach).toHaveBeenCalledOnce()
    expect(WebSocketBridgeServer.prototype.stop).toHaveBeenCalledOnce()
    expect(BridgeReceiver.prototype.stopAndDrain).toHaveBeenCalledOnce()
  })

  it('releases receiver, listener and stream when manifest sync fails', async () => {
    const failure = new Error('manifest sync failed')
    vi.mocked(
      NativeMessagingInstaller.prototype.syncManifests
    ).mockRejectedValueOnce(failure)

    await expect(bootstrapBridge(args())).rejects.toBe(failure)

    expect(BridgeStreamSource.prototype.detach).toHaveBeenCalledOnce()
    expect(WebSocketBridgeServer.prototype.stop).toHaveBeenCalledOnce()
    expect(BridgeReceiver.prototype.stopAndDrain).toHaveBeenCalledOnce()
    expect(NativeMessagingInstaller.prototype.unregister).toHaveBeenCalledOnce()
    expect(EndpointFileWriter.prototype.write).not.toHaveBeenCalled()
    expect(activeChannels.size).toBe(0)
  })

  it.each([
    [false, 'test', true],
    [true, 'test', false],
    [false, 'production', false],
  ] as const)(
    'gates an env development id for isPackaged=%s NODE_ENV=%s',
    async (isPackaged, nodeEnv, expectedOfficial) => {
      const devId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      const previous = process.env.MOTRIX_DEV_TRUSTED_EXTENSIONS
      const previousNodeEnv = process.env.NODE_ENV
      process.env.MOTRIX_DEV_TRUSTED_EXTENSIONS = `chromium:${devId}`
      process.env.NODE_ENV = nodeEnv
      electron.isPackaged = isPackaged
      snapRuntime.enabled = isPackaged
      let runtime: Awaited<ReturnType<typeof bootstrapBridge>> = null

      try {
        runtime = await bootstrapBridge(args())
        expect(runtime).not.toBeNull()
        if (runtime === null) throw new Error('bridge did not start')
        const manifests = vi
          .mocked(NativeMessagingInstaller.prototype.syncManifests)
          .mock.calls.at(-1)?.[0]
        expect(manifests?.chromium.includes(devId)).toBe(expectedOfficial)

        const mbp1 = (
          runtime.server as unknown as {
            mbp1: {
              isOfficialId(browser: 'chromium', id: string): boolean
            } | null
          }
        ).mbp1
        expect(mbp1?.isOfficialId('chromium', devId)).toBe(expectedOfficial)
      } finally {
        await runtime?.shutdown()
        if (previous === undefined) {
          delete process.env.MOTRIX_DEV_TRUSTED_EXTENSIONS
        } else {
          process.env.MOTRIX_DEV_TRUSTED_EXTENSIONS = previous
        }
        if (previousNodeEnv === undefined) {
          delete process.env.NODE_ENV
        } else {
          process.env.NODE_ENV = previousNodeEnv
        }
      }
    }
  )

  it.each(['EACCES', 'EPERM'] as const)(
    'keeps the bridge live when Snap manifest sync fails with %s',
    async (code) => {
      snapRuntime.enabled = true
      electron.isPackaged = true
      const permissionError = Object.assign(new Error('permission denied'), {
        code,
      })
      vi.mocked(
        NativeMessagingInstaller.prototype.syncManifests
      ).mockRejectedValueOnce(permissionError)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const runtime = await bootstrapBridge(args())

      expect(runtime).not.toBeNull()
      expect(EndpointFileWriter.prototype.write).toHaveBeenCalledOnce()
      expect(WebSocketBridgeServer.prototype.stop).not.toHaveBeenCalled()
      expect(BridgeReceiver.prototype.stopAndDrain).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'sudo snap connect motrix_work:browser-native-messaging'
        )
      )
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('restart Motrix')
      )

      await runtime?.shutdown()
    }
  )

  it('rolls back EACCES outside a packaged Linux Snap', async () => {
    const permissionError = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    })
    vi.mocked(
      NativeMessagingInstaller.prototype.syncManifests
    ).mockRejectedValueOnce(permissionError)

    await expect(bootstrapBridge(args())).rejects.toBe(permissionError)

    expect(EndpointFileWriter.prototype.write).not.toHaveBeenCalled()
    expect(WebSocketBridgeServer.prototype.stop).toHaveBeenCalledOnce()
    expect(BridgeReceiver.prototype.stopAndDrain).toHaveBeenCalledOnce()
    expect(NativeMessagingInstaller.prototype.unregister).toHaveBeenCalledOnce()
  })

  it('rolls back non-permission manifest errors inside Snap', async () => {
    snapRuntime.enabled = true
    electron.isPackaged = true
    const ioError = Object.assign(new Error('input/output error'), {
      code: 'EIO',
    })
    vi.mocked(
      NativeMessagingInstaller.prototype.syncManifests
    ).mockRejectedValueOnce(ioError)

    await expect(bootstrapBridge(args())).rejects.toBe(ioError)

    expect(EndpointFileWriter.prototype.write).not.toHaveBeenCalled()
    expect(WebSocketBridgeServer.prototype.stop).toHaveBeenCalledOnce()
    expect(BridgeReceiver.prototype.stopAndDrain).toHaveBeenCalledOnce()
    expect(NativeMessagingInstaller.prototype.unregister).toHaveBeenCalledOnce()
  })

  it('clears endpoint and releases all earlier ownership when endpoint write fails', async () => {
    const failure = new Error('endpoint write failed')
    vi.mocked(EndpointFileWriter.prototype.write).mockRejectedValueOnce(failure)

    await expect(bootstrapBridge(args())).rejects.toBe(failure)

    expect(EndpointFileWriter.prototype.clear).toHaveBeenCalledOnce()
    expect(BridgeStreamSource.prototype.detach).toHaveBeenCalledOnce()
    expect(WebSocketBridgeServer.prototype.stop).toHaveBeenCalledOnce()
    expect(BridgeReceiver.prototype.stopAndDrain).toHaveBeenCalledOnce()
    expect(NativeMessagingInstaller.prototype.unregister).toHaveBeenCalledOnce()
    expect(activeChannels.size).toBe(0)
  })

  it('removes the installed IPC subset when a later registration throws', async () => {
    const failure = new Error('ipc registration failed')
    let registrations = 0
    electron.handle.mockImplementation((channel: string) => {
      registrations += 1
      if (registrations === 4) throw failure
      activeChannels.add(channel)
    })

    await expect(bootstrapBridge(args())).rejects.toBe(failure)

    expect(electron.removeHandler).toHaveBeenCalledTimes(3)
    expect(activeChannels.size).toBe(0)
    expect(EndpointFileWriter.prototype.clear).toHaveBeenCalledOnce()
    expect(BridgeStreamSource.prototype.detach).toHaveBeenCalledOnce()
    expect(WebSocketBridgeServer.prototype.stop).toHaveBeenCalledOnce()
    expect(BridgeReceiver.prototype.stopAndDrain).toHaveBeenCalledOnce()
    expect(NativeMessagingInstaller.prototype.unregister).toHaveBeenCalledOnce()
  })

  it('removes every IPC handler on shutdown so disable/re-enable is clean', async () => {
    const first = await bootstrapBridge(args())
    expect(first).not.toBeNull()
    expect(activeChannels.size).toBeGreaterThan(0)
    await first?.shutdown()
    expect(activeChannels.size).toBe(0)
    expect(NativeMessagingInstaller.prototype.unregister).not.toHaveBeenCalled()

    const second = await bootstrapBridge(args())
    expect(second).not.toBeNull()
    await second?.shutdown()
    expect(activeChannels.size).toBe(0)
    expect(NativeMessagingInstaller.prototype.unregister).not.toHaveBeenCalled()
  })

  it('stops listener admission before draining pairing persistence', async () => {
    const shutdownOrder: string[] = []
    vi.mocked(WebSocketBridgeServer.prototype.stop).mockImplementation(
      async () => {
        shutdownOrder.push('server')
      }
    )
    vi.mocked(PairingService.prototype.stopAndDrain).mockImplementation(
      async () => {
        shutdownOrder.push('pairing')
      }
    )

    const runtime = await bootstrapBridge(args())
    await runtime?.shutdown()

    expect(shutdownOrder).toEqual(['server', 'pairing'])
  })

  it('aborts and drains a pending MBP1 prompt during bridge shutdown', async () => {
    const runtime = await bootstrapBridge(args())
    expect(runtime).not.toBeNull()
    if (!runtime) return

    const request: PairDialogRequest = {
      browser: 'chromium',
      claimedExtensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      identity: 'official',
      code: '1234-5678',
      pairingNonce: 'nonce-shutdown',
      verifiedOrigin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }
    const queuePrompt = (
      runtime.server as unknown as {
        opts: {
          queueMbp1Dialog?: (
            value: PairDialogRequest
          ) => PairingPromptEnqueueResult
        }
      }
    ).opts.queueMbp1Dialog
    expect(queuePrompt).toBeTypeOf('function')
    if (!queuePrompt) return

    const result = queuePrompt(request)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    await expect(result.handle.published).resolves.toBe('delivered')
    const settled = vi.fn()
    runtime.bus.on('PairRequestSettled', settled)

    await runtime.shutdown()

    await expect(result.handle.terminal).resolves.toBe('aborted')
    expect(settled).toHaveBeenCalledExactlyOnceWith({
      key: 'chromium:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:nonce-shutdown',
      outcome: 'aborted',
    })
    expect(queuePrompt(request)).toEqual({ ok: false, reason: 'disposed' })
  })

  describe('MBP1 identity persistence (§9.2) and the Paired seam', () => {
    const extensionIdentity = {
      kind: 'extension' as const,
      browser: 'chromium' as const,
      extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }

    type LiveBridgeRuntime = NonNullable<
      Awaited<ReturnType<typeof bootstrapBridge>>
    >

    function extensionServerOptions(runtime: LiveBridgeRuntime) {
      return (
        runtime.server as unknown as {
          opts: {
            onExtensionAuthenticated?: (
              identity: typeof extensionIdentity,
              credentialId: string
            ) => void
            credentials: Mbp1CredentialStore
          }
        }
      ).opts
    }

    function revokeExtensionHandler() {
      return electron.handle.mock.calls.find(
        ([channel]) => channel === 'bridge:revokePair'
      )?.[1] as
        | ((
            event: unknown,
            params: { identity: typeof extensionIdentity }
          ) => Promise<unknown>)
        | undefined
    }

    async function commitAndProjectExtension(runtime: LiveBridgeRuntime) {
      const opts = extensionServerOptions(runtime)
      const credential = await opts.credentials.offerProvisional(
        {
          browser: extensionIdentity.browser,
          verifiedOrigin: `chrome-extension://${extensionIdentity.extensionId}`,
          clientInstallationId: 'install-a',
        },
        'official'
      )
      await opts.credentials.commitFromPair(credential.credentialId)
      opts.onExtensionAuthenticated?.(
        extensionIdentity,
        credential.credentialId
      )
      await vi.waitFor(() =>
        expect(runtime.extensionPairings.list()).toHaveLength(1)
      )
      return { opts, credential }
    }

    it('persists localToken across a restart while rotating serverGeneration', async () => {
      const writeCalls: Array<{
        port: number
        localToken: string
        generation: string
      }> = []
      vi.mocked(EndpointFileWriter.prototype.write).mockImplementation(
        async (port, localToken, generation) => {
          writeCalls.push({ port, localToken, generation })
        }
      )

      const first = await bootstrapBridge(args())
      await first?.shutdown()
      const second = await bootstrapBridge(args())
      await second?.shutdown()

      expect(writeCalls).toHaveLength(2)
      // §9.2: localToken MUST survive a restart — only serverGeneration
      // rotates. A rotating localToken would MAC-fail every in-flight NM
      // ticket into an abort instead of the spec's graceful `unverified`
      // downgrade.
      expect(writeCalls[0]?.localToken).toBe(writeCalls[1]?.localToken)
      expect(writeCalls[0]?.localToken).not.toBe('')
      expect(writeCalls[0]?.generation).not.toBe(writeCalls[1]?.generation)
    })

    it('records the exact committed credential and durably revokes the whole extension identity', async () => {
      const runtime = await bootstrapBridge(args())
      expect(runtime).not.toBeNull()
      if (!runtime) return

      // Reach the real callback WebSocketBridgeServer's constructor was
      // given — the exact seam `adoptAuthenticatedSession` invokes on
      // every successful MBP1 authentication (Task 18's own tests prove
      // THAT call fires; this proves the desktop shell's closure).
      const opts = extensionServerOptions(runtime)
      expect(opts.onExtensionAuthenticated).toBeTypeOf('function')

      const credential = await opts.credentials.offerProvisional(
        {
          browser: extensionIdentity.browser,
          verifiedOrigin: `chrome-extension://${extensionIdentity.extensionId}`,
          clientInstallationId: 'install-a',
        },
        'official'
      )
      await opts.credentials.commitFromPair(credential.credentialId)
      const successor = await opts.credentials.offerProvisional(
        {
          browser: extensionIdentity.browser,
          verifiedOrigin: `chrome-extension://${extensionIdentity.extensionId}`,
          clientInstallationId: 'install-a',
        },
        'official'
      )

      // Inject a live session the way `adoptAuthenticatedSession` would,
      // so the revoke-kick has something to find and close.
      const conn = {
        sendNotification: vi.fn(),
        revokeAuthorization: vi.fn(),
        dispose: vi.fn(),
      }
      const envelope = { close: vi.fn() }
      ;(
        runtime.server as unknown as { sessions: Map<string, unknown> }
      ).sessions.set('chromium:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
        conn,
        envelope,
        extensionId: extensionIdentity.extensionId,
        browser: extensionIdentity.browser,
        startedAt: Date.now(),
      })

      opts.onExtensionAuthenticated?.(
        extensionIdentity,
        credential.credentialId
      )
      await vi.waitFor(() =>
        expect(runtime.extensionPairings.list()).toHaveLength(1)
      )
      expect(runtime.extensionPairings.list()[0]?.identity).toEqual(
        extensionIdentity
      )
      expect(runtime.extensionPairings.list()[0]).toMatchObject({
        identityTrust: 'official',
        status: 'ready',
        pairedAt: expect.any(Number),
      })

      const revokeHandler = revokeExtensionHandler()
      expect(revokeHandler).toBeTypeOf('function')

      await revokeHandler?.(undefined, { identity: extensionIdentity })

      expect(opts.credentials.findForAuth(credential.credentialId)).toBeNull()
      expect(opts.credentials.findForAuth(successor.credentialId)).toBeNull()
      expect(runtime.extensionPairings.list()).toHaveLength(0)
      expect(conn.sendNotification).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ reason: 'user-revoked' })
      )
      expect(envelope.close).toHaveBeenCalledWith(1000)
      expect(conn.revokeAuthorization).toHaveBeenCalled()
      expect(conn.dispose).toHaveBeenCalledOnce()
      expect(
        runtime.server.getSession('chromium:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      ).toBeUndefined()

      await runtime.shutdown()
    })

    it('keeps the credential durable but immediately quarantines an unprojectable authenticated session', async () => {
      const runtime = await bootstrapBridge(args())
      expect(runtime).not.toBeNull()
      if (!runtime) return

      const opts = extensionServerOptions(runtime)
      const credential = await opts.credentials.offerProvisional(
        {
          browser: extensionIdentity.browser,
          verifiedOrigin: `chrome-extension://${extensionIdentity.extensionId}`,
          clientInstallationId: 'install-a',
        },
        'official'
      )
      await opts.credentials.commitFromPair(credential.credentialId)

      const paired = vi.fn()
      const errors = vi.fn()
      runtime.bus.on('Paired', paired)
      runtime.bus.on('Error', errors)
      const conn = {
        revokeAuthorization: vi.fn(),
        dispose: vi.fn(),
      }
      const envelope = { close: vi.fn() }
      ;(
        runtime.server as unknown as { sessions: Map<string, unknown> }
      ).sessions.set('chromium:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
        conn,
        envelope,
        extensionId: extensionIdentity.extensionId,
        browser: extensionIdentity.browser,
        startedAt: Date.now(),
      })
      vi.spyOn(
        runtime.extensionPairings,
        'recordAuthenticated'
      ).mockRejectedValueOnce(new Error('secret projection path'))

      opts.onExtensionAuthenticated?.(
        extensionIdentity,
        credential.credentialId
      )

      await vi.waitFor(() =>
        expect(errors).toHaveBeenCalledExactlyOnceWith({
          code: 'extensionProjectionDegraded',
          message:
            'Extension pairing state could not be updated; access is closed until startup repair.',
        })
      )
      expect(paired).not.toHaveBeenCalled()
      expect(
        opts.credentials.findForAuth(credential.credentialId)
      ).not.toBeNull()
      expect(conn.revokeAuthorization).toHaveBeenCalled()
      expect(envelope.close).toHaveBeenCalledWith(1000)
      expect(conn.dispose).toHaveBeenCalledOnce()
      expect(
        runtime.server.getSession('chromium:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      ).toBeUndefined()

      await runtime.shutdown()
    })

    it('retains a durable pending marker and deny gate when credential revocation fails', async () => {
      const runtime = await bootstrapBridge(args())
      expect(runtime).not.toBeNull()
      if (!runtime) return

      const { opts, credential } = await commitAndProjectExtension(runtime)
      const errors = vi.fn()
      const revoked = vi.fn()
      runtime.bus.on('Error', errors)
      runtime.bus.on('Revoked', revoked)
      vi.spyOn(
        runtime.server,
        'deleteExtensionAuthorization'
      ).mockRejectedValueOnce(
        new Error('secret credential persistence failure')
      )

      await expect(
        revokeExtensionHandler()?.(undefined, {
          identity: extensionIdentity,
        })
      ).rejects.toThrow('extension revocation incomplete')

      expect(runtime.extensionPairings.list()).toMatchObject([
        { identity: extensionIdentity, status: 'cleanup-pending' },
      ])
      expect(
        opts.credentials.findForAuth(credential.credentialId)
      ).not.toBeNull()
      expect(
        runtime.extensionPairings.canAdmitIdentity(extensionIdentity)
      ).toBe(false)
      expect(revoked).not.toHaveBeenCalled()
      expect(errors).toHaveBeenCalledExactlyOnceWith({
        code: 'extensionRevocationIncomplete',
        message:
          'Extension revocation is incomplete; access remains closed and startup will retry it.',
      })

      await runtime.shutdown()
    })

    it('cuts live authorization before a blocked pending-revoke marker write', async () => {
      const runtime = await bootstrapBridge(args())
      expect(runtime).not.toBeNull()
      if (!runtime) return

      await commitAndProjectExtension(runtime)
      const conn = {
        revokeAuthorization: vi.fn(),
        dispose: vi.fn(),
      }
      const envelope = { close: vi.fn() }
      ;(
        runtime.server as unknown as { sessions: Map<string, unknown> }
      ).sessions.set('chromium:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', {
        conn,
        envelope,
        extensionId: extensionIdentity.extensionId,
        browser: extensionIdentity.browser,
        startedAt: Date.now(),
      })

      let announceMarkerWrite!: () => void
      const markerWriteEntered = new Promise<void>((resolve) => {
        announceMarkerWrite = resolve
      })
      let releaseMarkerWrite!: () => void
      const markerWriteReleased = new Promise<void>((resolve) => {
        releaseMarkerWrite = resolve
      })
      const prepare = runtime.extensionPairings.prepareIdentityCleanup.bind(
        runtime.extensionPairings
      )
      vi.spyOn(
        runtime.extensionPairings,
        'prepareIdentityCleanup'
      ).mockImplementationOnce(async (identity) => {
        announceMarkerWrite()
        await markerWriteReleased
        return prepare(identity)
      })

      const revoke = revokeExtensionHandler()?.(undefined, {
        identity: extensionIdentity,
      })
      await markerWriteEntered

      expect(conn.revokeAuthorization).toHaveBeenCalledOnce()
      expect(
        (
          runtime.server as unknown as {
            revokingExtensionKeys: Map<string, unknown>
          }
        ).revokingExtensionKeys.has('chromium:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      ).toBe(true)

      releaseMarkerWrite()
      await expect(revoke).resolves.toBeUndefined()
      expect(runtime.extensionPairings.list()).toEqual([])
      expect(
        (
          runtime.server as unknown as {
            revokingExtensionKeys: Map<string, unknown>
          }
        ).revokingExtensionKeys.has('chromium:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      ).toBe(false)

      await runtime.shutdown()
    })

    it('keeps admission closed and reports a fixed repair signal when projection cleanup fails after revocation', async () => {
      const runtime = await bootstrapBridge(args())
      expect(runtime).not.toBeNull()
      if (!runtime) return

      const { opts, credential } = await commitAndProjectExtension(runtime)
      const revoked = vi.fn()
      const errors = vi.fn()
      runtime.bus.on('Revoked', revoked)
      runtime.bus.on('Error', errors)
      vi.spyOn(
        runtime.extensionPairings,
        'completeCleanup'
      ).mockRejectedValueOnce(new Error('secret projection path'))

      await expect(
        revokeExtensionHandler()?.(undefined, {
          identity: extensionIdentity,
        })
      ).rejects.toThrow('extension revocation incomplete')

      expect(opts.credentials.findForAuth(credential.credentialId)).toBeNull()
      expect(runtime.extensionPairings.list()).toMatchObject([
        { identity: extensionIdentity, status: 'cleanup-pending' },
      ])
      expect(
        runtime.extensionPairings.canAdmitIdentity(extensionIdentity)
      ).toBe(false)
      expect(revoked).not.toHaveBeenCalled()
      expect(errors).toHaveBeenCalledExactlyOnceWith({
        code: 'extensionRevocationIncomplete',
        message:
          'Extension revocation is incomplete; access remains closed and startup will retry it.',
      })

      await runtime.shutdown()
    })

    it('does not delete credentials when the pending-revoke marker cannot be persisted', async () => {
      const runtime = await bootstrapBridge(args())
      expect(runtime).not.toBeNull()
      if (!runtime) return

      const { opts, credential } = await commitAndProjectExtension(runtime)
      const revoked = vi.fn()
      const errors = vi.fn()
      runtime.bus.on('Revoked', revoked)
      runtime.bus.on('Error', errors)
      vi.spyOn(
        runtime.extensionPairings,
        'prepareIdentityCleanup'
      ).mockRejectedValueOnce(new Error('secret projection failure'))

      await expect(
        revokeExtensionHandler()?.(undefined, {
          identity: extensionIdentity,
        })
      ).rejects.toThrow('extension revocation incomplete')

      expect(
        opts.credentials.findForAuth(credential.credentialId)
      ).not.toBeNull()
      expect(revoked).not.toHaveBeenCalled()
      expect(errors).toHaveBeenCalledExactlyOnceWith({
        code: 'extensionRevocationMarkerFailed',
        message:
          'Extension revocation could not be recorded; access is closed for this run, but restart may restore the old credential.',
      })

      await runtime.shutdown()
    })

    it('restores a durable pending revoke and finishes it before the next listener starts', async () => {
      const first = await bootstrapBridge(args())
      expect(first).not.toBeNull()
      if (!first) return

      const { credential } = await commitAndProjectExtension(first)
      await first.extensionPairings.prepareIdentityCleanup(extensionIdentity)
      await first.shutdown()
      vi.mocked(WebSocketBridgeServer.prototype.startOnFirstFree).mockClear()

      const second = await bootstrapBridge(args())
      expect(second).not.toBeNull()
      if (!second) return
      const secondOptions = extensionServerOptions(second)

      expect(
        secondOptions.credentials.findForAuth(credential.credentialId)
      ).toBeNull()
      expect(second.extensionPairings.list()).toEqual([])
      expect(
        WebSocketBridgeServer.prototype.startOnFirstFree
      ).toHaveBeenCalledOnce()

      await second.shutdown()
    })

    it('keeps the listener closed when startup cannot finish a durable pending revoke', async () => {
      const first = await bootstrapBridge(args())
      expect(first).not.toBeNull()
      if (!first) return

      const { credential } = await commitAndProjectExtension(first)
      await first.extensionPairings.prepareIdentityCleanup(extensionIdentity)
      await first.shutdown()
      vi.mocked(WebSocketBridgeServer.prototype.startOnFirstFree).mockClear()

      const deleteFailure = vi
        .spyOn(Mbp1CredentialStore.prototype, 'revokeExtensionIdentity')
        .mockRejectedValueOnce(new Error('secret durable path'))
      await expect(bootstrapBridge(args())).rejects.toThrow(
        'extension revocation recovery failed'
      )
      expect(
        WebSocketBridgeServer.prototype.startOnFirstFree
      ).not.toHaveBeenCalled()
      deleteFailure.mockRestore()

      const recovered = await bootstrapBridge(args())
      expect(recovered).not.toBeNull()
      if (!recovered) return
      expect(
        extensionServerOptions(recovered).credentials.findForAuth(
          credential.credentialId
        )
      ).toBeNull()
      expect(recovered.extensionPairings.list()).toEqual([])

      await recovered.shutdown()
    })
  })

  describe('bridge:getStatus (Task 21)', () => {
    function getStatusHandler() {
      return electron.handle.mock.calls.find(
        ([channel]) => channel === 'bridge:getStatus'
      )?.[1] as (() => Promise<BridgeStatusInfo>) | undefined
    }

    it('reports the bound port, fixedPort policy, and instanceId when nominal', async () => {
      const runtime = await bootstrapBridge(args())
      expect(runtime).not.toBeNull()
      if (!runtime) return

      const handler = getStatusHandler()
      expect(handler).toBeTypeOf('function')
      await expect(handler?.()).resolves.toEqual({
        port: 19002,
        degraded: false,
        extensionPairingHealth: 'ready',
        fixedPort: 'auto',
        instanceId: 'test-instance-id',
      })

      await runtime.shutdown()
    })

    it('surfaces degraded: true and the ephemeral port when every candidate port was taken (§4)', async () => {
      vi.mocked(
        WebSocketBridgeServer.prototype.startOnFirstFree
      ).mockResolvedValueOnce({ port: 54321, degraded: true })

      const runtime = await bootstrapBridge(args())
      expect(runtime).not.toBeNull()
      if (!runtime) return

      await expect(getStatusHandler()?.()).resolves.toEqual({
        port: 54321,
        degraded: true,
        extensionPairingHealth: 'ready',
        fixedPort: 'auto',
        instanceId: 'test-instance-id',
      })

      await runtime.shutdown()
    })

    it('reflects a pinned fixedPort and instanceId from persisted bridge settings', async () => {
      const runtime = await bootstrapBridge({
        ...args(),
        bridgeSettings: { fixedPort: 18080, instanceId: 'pinned-instance' },
      })
      expect(runtime).not.toBeNull()
      if (!runtime) return

      await expect(getStatusHandler()?.()).resolves.toMatchObject({
        fixedPort: 18080,
        instanceId: 'pinned-instance',
      })

      await runtime.shutdown()
    })
  })
})
