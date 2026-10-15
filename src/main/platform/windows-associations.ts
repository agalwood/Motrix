import {
  WindowsAssociationsRequestSchema,
  WindowsAssociationsResponseSchema,
} from '@shared/schemas/windows-default-apps'
import {
  createWindowsPlatformClient,
  type WindowsPlatformClientDeps,
} from './windows-platform-client'

export function createWindowsAssociationsClient(
  deps: WindowsPlatformClientDeps = {}
) {
  const client = createWindowsPlatformClient(
    {
      request: WindowsAssociationsRequestSchema,
      response: WindowsAssociationsResponseSchema,
    },
    deps
  )
  return {
    query() {
      return client.request({ version: 1, op: 'associations_query' })
    },
  }
}

const client = createWindowsAssociationsClient()
export const queryWindowsAssociations = client.query
