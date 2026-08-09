import type { EngineAdapter } from '@core/engine/engine-adapter'
import type { GeoIPManager } from '@core/geoip/geo-ip-manager'
import type { TaskPeer } from '@shared/types/peer'

export interface GetTaskPeersDeps {
  engineAdapter: Pick<EngineAdapter, 'getTaskPeers'>
  taskManager: {
    getById: (id: string) => { engineTaskId: string } | undefined
  }
  geoipManager: Pick<GeoIPManager, 'isEnabled' | 'lookupCountry'>
}

export interface GetTaskPeersPayload {
  taskId: string
}

export function createGetTaskPeersHandler(deps: GetTaskPeersDeps) {
  return async ({ taskId }: GetTaskPeersPayload): Promise<TaskPeer[]> => {
    const task = deps.taskManager.getById(taskId)
    if (!task) return []
    const peers = await deps.engineAdapter.getTaskPeers(task.engineTaskId)
    if (!deps.geoipManager.isEnabled()) return peers
    return peers.map((peer) => ({
      ...peer,
      country: deps.geoipManager.lookupCountry(peer.ip),
    }))
  }
}
