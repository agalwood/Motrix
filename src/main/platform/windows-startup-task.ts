import {
  type WindowsStartupTaskRequest,
  WindowsStartupTaskRequestSchema,
  WindowsStartupTaskResponseSchema,
} from '@shared/schemas/auto-launch'
import {
  createWindowsPlatformClient,
  type WindowsPlatformClientDeps,
} from './windows-platform-client'

export function createWindowsStartupTaskClient(
  deps: WindowsPlatformClientDeps = {}
) {
  const client = createWindowsPlatformClient(
    {
      request: WindowsStartupTaskRequestSchema,
      response: WindowsStartupTaskResponseSchema,
    },
    deps
  )
  return {
    request(op: WindowsStartupTaskRequest['op']) {
      return client.request({ version: 1, op })
    },
  }
}

const client = createWindowsStartupTaskClient()
export const requestWindowsStartupTask = client.request
