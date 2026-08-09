import type { EngineAdapter } from '@core/engine/engine-adapter'
import { describe, expect, it, vi } from 'vitest'
import { createGetEngineTaskOptionsHandler } from './get-engine-task-options'

describe('getEngineTaskOptions handler', () => {
  it('delegates to adapter.getEngineTaskOptions', async () => {
    const engine = {
      getEngineTaskOptions: vi
        .fn()
        .mockResolvedValue({ dir: '/tmp', header: ['User-Agent: Foo'] }),
    } as unknown as Pick<EngineAdapter, 'getEngineTaskOptions'>
    const handler = createGetEngineTaskOptionsHandler({ engine })
    const result = await handler('gid-1')
    expect(engine.getEngineTaskOptions).toHaveBeenCalledWith('gid-1')
    expect(result).toEqual({ dir: '/tmp', header: ['User-Agent: Foo'] })
  })

  it('returns null when adapter returns null', async () => {
    const engine = {
      getEngineTaskOptions: vi.fn().mockResolvedValue(null),
    } as unknown as Pick<EngineAdapter, 'getEngineTaskOptions'>
    const handler = createGetEngineTaskOptionsHandler({ engine })
    expect(await handler('gid-1')).toBeNull()
  })
})
