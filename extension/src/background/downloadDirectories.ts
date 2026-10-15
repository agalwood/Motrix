import { DownloadDirectoriesResultSchema, Methods } from '@motrix/mdxp'
import type { ConnectionManager } from '@/background/ConnectionManager'
import type { HandoffGuard } from '@/background/handoff/guard'
import {
  isExtensionPageSender,
  type ManualTaskMessageSender,
} from '@/background/manualTask'
import type { DownloadDirectoriesResponse } from '@/shared/downloadDirectories'

export function createDownloadDirectoriesHandler(deps: {
  extensionId: string
  extensionBaseUrl: string
  captureGuard(): Promise<HandoffGuard | null>
  manager: Pick<
    ConnectionManager,
    'getServerIdentity' | 'getServerCapabilities' | 'getState' | 'request'
  >
}) {
  return async (
    _request: undefined,
    sender: ManualTaskMessageSender
  ): Promise<DownloadDirectoriesResponse> => {
    if (!isExtensionPageSender(sender, deps.extensionId, deps.extensionBaseUrl))
      throw new Error('download.rejected')
    try {
      const guard = await deps.captureGuard()
      const instanceId = deps.manager.getServerIdentity()?.instanceId
      if (
        !guard?.endpointId ||
        !instanceId ||
        deps.manager.getState() !== 'connected'
      )
        return { status: 'unavailable' }
      if (!deps.manager.getServerCapabilities()?.downloadDirectories)
        return { status: 'unsupported' }
      guard.assertCurrent()
      const directories = DownloadDirectoriesResultSchema.parse(
        await deps.manager.request(Methods.DownloadDirectories, {})
      )
      guard.assertCurrent()
      if (deps.manager.getServerIdentity()?.instanceId !== instanceId)
        return { status: 'unavailable' }
      return {
        status: 'ready',
        directories,
        binding: {
          endpointId: guard.endpointId,
          endpointRevision: guard.endpointRevision ?? 0,
          instanceId,
        },
      }
    } catch {
      return { status: 'unavailable' }
    }
  }
}
