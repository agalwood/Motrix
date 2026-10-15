import { describe, expect, it, vi } from 'vitest'
import { AutoOpenPopupService } from '@/background/AutoOpenPopupService'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'

function fixture() {
  let now = 100000
  let config = {
    ...TAKEOVER_DEFAULT,
    enabled: true,
    openTaskPanelAfterSubmit: true,
  }
  let backing: Record<string, unknown> = {}
  const deps = {
    supported: vi.fn(() => true),
    config: vi.fn(async () => config),
    focusedWindow: vi.fn(async () => 1 as number | null),
    isOpen: vi.fn(() => false),
    open: vi.fn(async () => {}),
    publish: vi.fn(async () => {}),
    storage: {
      get: vi.fn(async () => structuredClone(backing)),
      set: vi.fn(async (items: Record<string, unknown>) => {
        backing = structuredClone(items)
      }),
    },
    now: () => now,
  }
  return {
    deps,
    service: new AutoOpenPopupService(deps),
    advance: (ms: number) => {
      now += ms
    },
    configure: (patch: Partial<typeof config>) => {
      config = { ...config, ...patch }
    },
  }
}
const accepted = (operationId = 'operation-1') => ({
  operationId,
  taskId: 'task-1',
  windowId: 1,
  endpointId: 'local',
  endpointRevision: 0,
  enabledAtCapture: true,
  assertCurrent: () => {},
})

describe('automatic popup presentation', () => {
  it('opens for explicit submissions with automatic takeover disabled, including remote backends', async () => {
    const { service, deps, configure } = fixture()
    configure({ enabled: false })
    const present = service.captureSubmission()
    await present(
      { taskId: 'task-1', operationId: 'op-explicit' },
      {
        origin: 'context-menu',
        endpointId: 'nas',
        endpointRevision: 2,
        assertCurrent: () => {},
      }
    )
    expect(deps.open).toHaveBeenCalledExactlyOnceWith(1)
    expect(await service.receipt(1)).toMatchObject({
      endpointId: 'nas',
      endpointRevision: 2,
    })
  })

  it('does not open if the preference was disabled when an explicit submission began', async () => {
    const { service, deps, configure } = fixture()
    configure({ openTaskPanelAfterSubmit: false })
    const present = service.captureSubmission()
    configure({ openTaskPanelAfterSubmit: true })
    await present(
      { taskId: 'task-1', operationId: 'op-explicit' },
      {
        origin: 'context-menu',
        endpointId: 'local',
        assertCurrent: () => {},
      }
    )
    expect(deps.open).not.toHaveBeenCalled()
  })
  it('opens once per batch, publishes subsequent receipts and starts a new batch after idle', async () => {
    const { service, deps, advance } = fixture()
    await service.present(accepted())
    advance(9000)
    await service.present(accepted('operation-2'))
    advance(9000)
    await service.present(accepted('operation-3'))
    expect(deps.open).toHaveBeenCalledExactlyOnceWith(1)
    expect(deps.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ count: 3 })
    )
    advance(10000)
    await service.present(accepted('operation-4'))
    expect(deps.open).toHaveBeenCalledTimes(2)
    expect(deps.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ count: 1 })
    )
  })

  it('survives worker restart without reopening a consumed batch or replaying a receipt', async () => {
    const { service, deps } = fixture()
    await service.present(accepted())
    const restarted = new AutoOpenPopupService(deps)
    await restarted.present(accepted())
    await restarted.present(accepted('operation-2'))
    expect(deps.open).toHaveBeenCalledOnce()
    expect(deps.publish).toHaveBeenCalledTimes(2)
    expect(await restarted.receipt(1)).toMatchObject({ count: 2 })
    expect(await restarted.receipt(2)).toBeNull()
  })

  it.each([
    'disabled',
    'unsupported',
    'capture-disabled',
    'no-task',
    'stale-endpoint',
  ])('does not present %s', async (reason) => {
    const { service, deps, configure } = fixture()
    const input = accepted()
    if (reason === 'disabled') configure({ openTaskPanelAfterSubmit: false })
    if (reason === 'unsupported') deps.supported.mockReturnValue(false)
    if (reason === 'capture-disabled') input.enabledAtCapture = false
    if (reason === 'no-task') input.taskId = ''
    if (reason === 'stale-endpoint')
      input.assertCurrent = () => {
        throw new Error('stale')
      }
    await service.present(input)
    expect(deps.open).not.toHaveBeenCalled()
    expect(deps.publish).not.toHaveBeenCalled()
  })

  it('consumes the batch when focus has changed and never opens it late', async () => {
    const { service, deps } = fixture()
    expect(await service.captureWindow()).toBe(1)
    deps.focusedWindow.mockResolvedValue(2)
    await service.present(accepted())
    deps.focusedWindow.mockResolvedValue(1)
    await service.present(accepted('operation-2'))
    expect(deps.open).not.toHaveBeenCalled()
  })

  it('refreshes an existing popup without reopening it, even after the user closes it', async () => {
    const { service, deps } = fixture()
    deps.isOpen.mockReturnValue(true)
    await service.present(accepted())
    deps.isOpen.mockReturnValue(false)
    await service.present(accepted('operation-2'))
    expect(deps.publish).toHaveBeenCalledTimes(2)
    expect(deps.open).not.toHaveBeenCalled()
  })

  it('isolates API rejection and consumes its batch', async () => {
    const { service, deps } = fixture()
    deps.open.mockRejectedValue(new Error('browser denied popup'))
    await expect(service.present(accepted())).resolves.toBeUndefined()
    await service.present(accepted('operation-2'))
    expect(deps.open).toHaveBeenCalledOnce()
  })

  it('serializes a concurrent burst and expires the receipt', async () => {
    const { service, deps, advance } = fixture()
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => service.present(accepted(`op-${i}`)))
    )
    expect(deps.open).toHaveBeenCalledOnce()
    expect(await service.receipt(1)).toMatchObject({ count: 12 })
    advance(10000)
    expect(await service.receipt(1)).toBeNull()
  })

  it('rechecks the preference just before presentation', async () => {
    const { service, deps, configure } = fixture()
    deps.focusedWindow.mockImplementation(async () => {
      configure({ openTaskPanelAfterSubmit: false })
      return 1
    })
    await service.present(accepted())
    expect(deps.open).not.toHaveBeenCalled()
    expect(deps.publish).not.toHaveBeenCalled()
  })
})
