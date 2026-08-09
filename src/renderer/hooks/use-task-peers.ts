import { usePolledQuery } from '@renderer/hooks/use-polled-query'
import { Queries } from '@shared/protocol/queries'
import type { TaskPeer } from '@shared/types/peer'

const EMPTY_PEERS: TaskPeer[] = []

export function useTaskPeers(taskId: string | null, enabled = true) {
  const peers = usePolledQuery<TaskPeer[]>(
    Queries.GetTaskPeers,
    taskId,
    taskId !== null ? { taskId } : null,
    { initial: EMPTY_PEERS, enabled }
  )
  return { peers: peers ?? EMPTY_PEERS }
}
