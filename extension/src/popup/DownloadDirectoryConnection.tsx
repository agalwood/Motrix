import { createContext, type ReactNode } from 'react'
import type { PopupState } from '@/popup/usePopupState'

// Share the existing popup poll; directory fields must not start their own
// connection poll or remount the user's draft when the backend changes.
export const DownloadDirectoryConnectionContext = createContext<string | null>(
  null
)

export function DownloadDirectoryConnectionProvider({
  state,
  children,
}: {
  state: PopupState
  children: ReactNode
}) {
  const endpointId = state.endpoint?.activeEndpointId
  const revision = state.endpoint?.servers.find(
    (server) => server.id === endpointId
  )?.revision
  const key = JSON.stringify([
    state.connection,
    state.rpc?.health,
    endpointId,
    revision,
    state.server?.instanceId,
    state.capabilities.downloadDirectories,
  ])
  return (
    <DownloadDirectoryConnectionContext value={key}>
      {children}
    </DownloadDirectoryConnectionContext>
  )
}
