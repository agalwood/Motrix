import { ErrorCode } from '@shared/errors'
import { EngineState } from '@shared/types/engine'
import { describe, expect, it, vi } from 'vitest'
import { startServerEngine } from './start-engine'

describe('server engine startup', () => {
  it('does not run dependent recovery when start resolves as Failed', async () => {
    const restore = vi.fn()
    const supervisor = {
      start: vi.fn().mockResolvedValue(undefined),
      getState: () => EngineState.Failed,
      getLastError: () => 'GID 283f007637e2399d is not unique.',
    }
    await expect(
      startServerEngine(supervisor, '/app/bin/aria2c').then(restore)
    ).rejects.toMatchObject({
      code: ErrorCode.EngineStartFailed,
      message: 'GID 283f007637e2399d is not unique.',
    })
    expect(restore).not.toHaveBeenCalled()
  })

  it('allows recovery only after Ready', async () => {
    const supervisor = {
      start: vi.fn().mockResolvedValue(undefined),
      getState: () => EngineState.Ready,
      getLastError: () => null,
    }
    await expect(
      startServerEngine(supervisor, '/app/bin/aria2c')
    ).resolves.toBeUndefined()
    expect(supervisor.start).toHaveBeenCalledWith('/app/bin/aria2c')
  })

  it('preserves a rejected startup error', async () => {
    const cause = new Error('spawn failed')
    await expect(
      startServerEngine(
        {
          start: vi.fn().mockRejectedValue(cause),
          getState: () => EngineState.Failed,
          getLastError: () => null,
        },
        '/app/bin/aria2c'
      )
    ).rejects.toBe(cause)
  })
})
