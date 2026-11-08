// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, ipc, mockApp } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  ipc: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  mockApp: {
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    disableHardwareAcceleration: vi.fn(),
    getGPUFeatureStatus: vi.fn(),
    isHardwareAccelerationEnabled: vi.fn(),
    getGPUInfo: vi.fn(),
  },
}))
vi.mock('electron', () => ({ app: mockApp }))
vi.mock('@core/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}))
vi.mock('../ipc/trusted-ipc', () => ({
  registerTrustedIpcHandler: (
    channel: string,
    handler: (...args: unknown[]) => Promise<unknown>
  ) => ipc.set(channel, handler),
}))

import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { GPU_HEALTHY_INTERVAL_MS, GraphicsRecovery } from './graphics-recovery'
import { setupGraphicsRecovery } from './graphics-recovery-runtime'

describe('desktop graphics lifecycle wiring', () => {
  let directory: string
  let runtime: ReturnType<typeof setupGraphicsRecovery> | undefined
  const failure = { type: 'GPU', reason: 'crashed', exitCode: 139 }
  const emit = (name: string, ...args: unknown[]) =>
    handlers.get(name)?.(...args)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    handlers.clear()
    ipc.clear()
    directory = mkdtempSync(path.join(tmpdir(), 'motrix-graphics-runtime-'))
    mockApp.on.mockImplementation((name, handler) =>
      handlers.set(name, handler)
    )
    mockApp.getGPUFeatureStatus.mockReturnValue({ gpu_compositing: 'enabled' })
    mockApp.isHardwareAccelerationEnabled.mockReturnValue(true)
    mockApp.getGPUInfo.mockResolvedValue({ gpuDevice: [] })
  })
  afterEach(() => {
    runtime?.stop()
    runtime = undefined
    vi.useRealTimers()
    rmSync(directory, { recursive: true, force: true })
  })

  const start = (enabled?: boolean) => {
    const settingsPath = path.join(directory, 'settings.json')
    if (enabled !== undefined)
      writeFileSync(
        settingsPath,
        JSON.stringify({ app: { hardwareAcceleration: enabled } })
      )
    runtime = setupGraphicsRecovery(directory, settingsPath)
    return runtime
  }

  it('applies a saved disabled switch synchronously before GPU initialization', () => {
    start(false)
    expect(mockApp.disableHardwareAcceleration).toHaveBeenCalledTimes(1)
    expect(mockApp.getGPUFeatureStatus).not.toHaveBeenCalled()
    expect(handlers.has('child-process-gone')).toBe(true)
  })

  it('records only GPU exits and never changes acceleration during this launch', () => {
    const { recovery } = start()
    for (let i = 0; i < 3; i++)
      emit('child-process-gone', {}, { ...failure, type: 'Utility' })
    expect(
      new GraphicsRecovery({
        statePath: path.join(directory, 'graphics-recovery.json'),
        hardwareAcceleration: true,
        warn: vi.fn(),
      }).recoveredAtStartup
    ).toBe(false)
    for (let i = 0; i < 3; i++) emit('child-process-gone', {}, failure)
    expect(recovery.getNotice()).toBeNull()
    expect(mockApp.disableHardwareAcceleration).not.toHaveBeenCalled()
    runtime!.stop()
    start()
    expect(mockApp.disableHardwareAcceleration).toHaveBeenCalledTimes(1)
  })

  it('counts recovery across a fresh runtime and only acknowledges a matching notice', async () => {
    start()
    for (let i = 0; i < 3; i++) emit('child-process-gone', {}, failure)
    runtime!.stop()
    start()
    const notice = await ipc.get(Queries.GetGraphicsRecoveryNotice)!()
    expect(notice).toEqual({ id: expect.any(String) })
    await expect(
      ipc.get(Commands.AcknowledgeGraphicsRecoveryNotice)!(
        {},
        { id: 'invalid' }
      )
    ).rejects.toThrow()
    expect(await ipc.get(Queries.GetGraphicsRecoveryNotice)!()).toEqual(notice)
    await ipc.get(Commands.AcknowledgeGraphicsRecoveryNotice)!({}, notice)
    expect(await ipc.get(Queries.GetGraphicsRecoveryNotice)!()).toBeNull()
  })

  it('requires a continuous healthy accelerated interval before resetting failures', () => {
    const { recovery } = start()
    const healthy = vi.spyOn(recovery, 'markHealthy')
    emit('gpu-info-update')
    vi.advanceTimersByTime(GPU_HEALTHY_INTERVAL_MS - 1)
    emit('child-process-gone', {}, failure)
    vi.advanceTimersByTime(1)
    expect(healthy).not.toHaveBeenCalled()
    emit('gpu-info-update')
    vi.advanceTimersByTime(GPU_HEALTHY_INTERVAL_MS)
    expect(healthy).toHaveBeenCalledTimes(1)
    expect(mockApp.getGPUInfo).toHaveBeenCalledTimes(1)
  })

  it('does not treat software rendering as healthy hardware or count shutdown failures', () => {
    const { recovery } = start()
    const healthy = vi.spyOn(recovery, 'markHealthy')
    const record = vi.spyOn(recovery, 'recordFailure')
    mockApp.getGPUFeatureStatus.mockReturnValue({
      gpu_compositing: 'unavailable_software',
    })
    emit('gpu-info-update')
    vi.advanceTimersByTime(GPU_HEALTHY_INTERVAL_MS)
    expect(healthy).not.toHaveBeenCalled()
    runtime!.stop()
    emit('child-process-gone', {}, failure)
    expect(record).not.toHaveBeenCalled()
    expect(mockApp.off).toHaveBeenCalledWith(
      'child-process-gone',
      expect.any(Function)
    )
  })
})
