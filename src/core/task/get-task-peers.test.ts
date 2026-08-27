import type { TaskPeer } from '@shared/types/peer'
import { describe, expect, it, vi } from 'vitest'
import { createGetTaskPeersHandler } from './get-task-peers'

const SAMPLE_PEER: TaskPeer = {
  id: '1.2.3.4:6881',
  ip: '1.2.3.4',
  port: 6881,
  client: 'qBittorrent',
  clientVersion: '4.6.0',
  progress: 0.5,
  downSpeed: 1024,
  upSpeed: 0,
  seeder: false,
  amChoking: false,
  peerChoking: true,
}

const disabledGeoIP = {
  isEnabled: () => false,
  lookupCountry: vi.fn(),
}

describe('getTaskPeers handler', () => {
  it('returns engine-reported peers without country when GeoIP is disabled', async () => {
    const engineAdapter = {
      getTaskPeers: vi.fn().mockResolvedValue([SAMPLE_PEER]),
    }
    const taskManager = {
      getById: vi.fn().mockReturnValue({ engineTaskId: 'gid-1' }),
    }
    const handler = createGetTaskPeersHandler({
      engineAdapter,
      taskManager,
      geoipManager: disabledGeoIP,
    })
    const result = await handler({ taskId: 'task-1' })
    expect(result).toEqual([SAMPLE_PEER])
    expect(disabledGeoIP.lookupCountry).not.toHaveBeenCalled()
    expect(engineAdapter.getTaskPeers).toHaveBeenCalledWith('gid-1')
  })

  it('returns empty array without calling engine when task is unknown', async () => {
    const engineAdapter = { getTaskPeers: vi.fn() }
    const taskManager = { getById: vi.fn().mockReturnValue(undefined) }
    const handler = createGetTaskPeersHandler({
      engineAdapter,
      taskManager,
      geoipManager: disabledGeoIP,
    })
    expect(await handler({ taskId: 'missing' })).toEqual([])
    expect(engineAdapter.getTaskPeers).not.toHaveBeenCalled()
  })

  it('injects country when GeoIP is enabled and lookup hits', async () => {
    const engineAdapter = {
      getTaskPeers: vi.fn().mockResolvedValue([SAMPLE_PEER]),
    }
    const taskManager = {
      getById: vi.fn().mockReturnValue({ engineTaskId: 'gid-1' }),
    }
    const geoipManager = {
      isEnabled: () => true,
      lookupCountry: vi
        .fn()
        .mockReturnValue({ code: 'US', name: 'United States' }),
    }
    const handler = createGetTaskPeersHandler({
      engineAdapter,
      taskManager,
      geoipManager,
    })
    const [first] = await handler({ taskId: 'task-1' })
    expect(first.country).toEqual({ code: 'US', name: 'United States' })
    expect(geoipManager.lookupCountry).toHaveBeenCalledWith('1.2.3.4')
  })

  it('injects null country when GeoIP is enabled but lookup misses', async () => {
    const engineAdapter = {
      getTaskPeers: vi.fn().mockResolvedValue([SAMPLE_PEER]),
    }
    const taskManager = {
      getById: vi.fn().mockReturnValue({ engineTaskId: 'gid-1' }),
    }
    const geoipManager = {
      isEnabled: () => true,
      lookupCountry: vi.fn().mockReturnValue(null),
    }
    const handler = createGetTaskPeersHandler({
      engineAdapter,
      taskManager,
      geoipManager,
    })
    const [first] = await handler({ taskId: 'task-1' })
    expect(first.country).toBeNull()
  })
})
