import { transport } from '@renderer/lib/transport'
import type { QueryChannel } from '@shared/protocol/queries'

export type SettingsReader = (channel: QueryChannel) => Promise<unknown>
type Listener = (read: SettingsReader) => Promise<void>
const listeners = new Set<Listener>()

/** Local invalidation after a confirmed save; never impersonates a host event. */
export function onSettingsRefresh(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export async function refreshRendererSettings(): Promise<void> {
  // Mirrors capture their generation before awaiting a shared HTTP/IPC read.
  // A newer host event or refresh can still supersede this snapshot.
  const reads = new Map<QueryChannel, Promise<unknown>>()
  const read: SettingsReader = (channel) => {
    let pending = reads.get(channel)
    if (!pending) {
      pending = transport.invoke(channel)
      reads.set(channel, pending)
    }
    return pending
  }
  const results = await Promise.allSettled(
    [...listeners].map(async (listener) => listener(read))
  )
  const failed = results.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
}
