import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EndpointFileWriter } from '@core/bridge/endpoint-file-writer'
import { PairingService } from '@core/bridge/pairing-service'
import { WebSocketBridgeServer } from '@core/bridge/web-socket-bridge-server'
import { BridgeReceiver } from '@core/bridge-receiver/bridge-receiver'
import { BridgeStreamSource } from '@core/bridge-receiver/bridge-stream-source'
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

import { bootstrapBridge } from './index'

function args(): Parameters<typeof bootstrapBridge>[0] {
  return {
    getMainWindow: () => null,
    motrixVersion: '2.0-test',
    ffmpegAvailable: false,
    enabled: true,
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
    vi.spyOn(WebSocketBridgeServer.prototype, 'start').mockResolvedValue(19002)
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
    expect(WebSocketBridgeServer.prototype.start).not.toHaveBeenCalled()
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
})
