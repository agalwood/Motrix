import { AppError, ErrorCode } from '@shared/errors'
import type {
  AutoLaunchStatus,
  WindowsStartupTaskRequest,
  WindowsStartupTaskResult,
} from '@shared/schemas/auto-launch'
import { app } from 'electron'
import {
  type DistributionContextInput,
  resolveDistributionContext,
} from './distribution-context'
import { requestWindowsStartupTask } from './windows-startup-task'

interface AutoLaunchServiceDeps {
  getContext?: () => DistributionContextInput
  setLoginItemSettings?: (settings: {
    openAtLogin: boolean
    args: string[]
  }) => void
  requestStartupTask?: (
    op: WindowsStartupTaskRequest['op']
  ) => Promise<WindowsStartupTaskResult>
}

export function createAutoLaunchService(deps: AutoLaunchServiceDeps = {}) {
  const getContext =
    deps.getContext ??
    (() => ({
      platform: process.platform,
      isPackaged: app.isPackaged,
      windowsStore: process.windowsStore,
    }))
  const setLoginItemSettings =
    deps.setLoginItemSettings ??
    ((settings) => app.setLoginItemSettings(settings))
  const requestStartupTask =
    deps.requestStartupTask ?? requestWindowsStartupTask

  function authority() {
    const input = getContext()
    const distribution = resolveDistributionContext(input)
    if (
      !input.isPackaged ||
      (input.platform !== 'win32' && input.platform !== 'darwin')
    )
      return 'unsupported' as const
    return distribution.isWindowsPackage
      ? ('windows-package' as const)
      : ('application' as const)
  }

  async function request(op: WindowsStartupTaskRequest['op']) {
    try {
      return await requestStartupTask(op)
    } catch {
      return { version: 1, ok: false, code: 'helper_failed' } as const
    }
  }

  return {
    async getAutoLaunchStatus(): Promise<AutoLaunchStatus> {
      const currentAuthority = authority()
      if (currentAuthority !== 'windows-package')
        return { authority: currentAuthority }
      return {
        authority: currentAuthority,
        result: await request('startup_query'),
      }
    },

    async syncAutoLaunch(
      enabled: boolean,
      origin: 'startup' | 'user' = 'user'
    ): Promise<void> {
      const currentAuthority = authority()
      if (currentAuthority === 'unsupported') return
      if (currentAuthority === 'windows-package') {
        const result = await request(
          origin === 'startup'
            ? 'startup_query'
            : enabled
              ? 'startup_enable'
              : 'startup_disable'
        )
        if (!result.ok)
          throw new AppError(
            ErrorCode.AutoLaunchFailed,
            'Unable to confirm Windows startup settings',
            result
          )
        const actualEnabled =
          result.state === 'enabled' || result.state === 'enabled_by_policy'
        if (origin === 'user' && actualEnabled !== enabled)
          throw new AppError(
            ErrorCode.AutoLaunchNotApplied,
            'Windows did not apply the requested startup setting',
            result
          )
        return
      }
      try {
        setLoginItemSettings({
          openAtLogin: enabled,
          args: enabled ? ['--opened-at-login=1'] : [],
        })
      } catch (error) {
        throw new AppError(
          ErrorCode.AutoLaunchFailed,
          'Unable to apply login startup settings',
          error
        )
      }
    },
  }
}

const service = createAutoLaunchService()
export const getAutoLaunchStatus = service.getAutoLaunchStatus
export const syncAutoLaunch = service.syncAutoLaunch
