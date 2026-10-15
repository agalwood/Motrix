import { Methods } from '@motrix/mdxp'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionManager } from '@/background/ConnectionManager'
import { requestTaskReveal } from '@/background/taskReveal'

type TaskRevealBridge = Pick<
  ConnectionManager,
  'getServerCapabilities' | 'request'
>

function bridgeWithCapability(initial: boolean | null): {
  bridge: TaskRevealBridge
  request: ReturnType<typeof vi.fn>
  setCapability: (value: boolean | null) => void
} {
  let capability = initial
  const request = vi.fn(async () => ({ ok: true as const }))
  return {
    bridge: {
      getServerCapabilities: () =>
        capability === null
          ? null
          : {
              ffmpegAvailable: true,
              selectionKinds: ['direct'],
              taskReveal: capability,
            },
      request,
    } as TaskRevealBridge,
    request,
    setCapability: (value) => {
      capability = value
    },
  }
}

describe('requestTaskReveal', () => {
  it('forwards only the task id when the current backend supports reveal', async () => {
    const { bridge, request } = bridgeWithCapability(true)

    await expect(
      requestTaskReveal(bridge, { taskId: 'task-1' })
    ).resolves.toEqual({ ok: true })
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(Methods.TaskReveal, {
      taskId: 'task-1',
    })
  })

  it.each([false, null])(
    'rejects unsupported capability %s without sending MDXP',
    async (capability) => {
      const { bridge, request } = bridgeWithCapability(capability)

      await expect(
        requestTaskReveal(bridge, { taskId: 'task-1' })
      ).rejects.toThrow(/does not support task\/reveal/)
      expect(request).not.toHaveBeenCalled()
    }
  )

  it('re-checks capability after an endpoint switch or disconnect', async () => {
    const { bridge, request, setCapability } = bridgeWithCapability(true)
    await requestTaskReveal(bridge, { taskId: 'task-1' })

    setCapability(null)
    await expect(
      requestTaskReveal(bridge, { taskId: 'task-2' })
    ).rejects.toThrow(/does not support task\/reveal/)
    expect(request).toHaveBeenCalledTimes(1)
  })
})
