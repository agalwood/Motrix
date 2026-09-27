import { AppError, ErrorCode } from '@shared/errors'
import type {
  WindowsStartupTaskResult,
  WindowsStartupTaskState,
} from '@shared/schemas/auto-launch'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: true, setLoginItemSettings: vi.fn() },
}))

import { createAutoLaunchService } from './auto-launch'
import type { DistributionContextInput } from './distribution-context'

const result = (state: WindowsStartupTaskState): WindowsStartupTaskResult => ({
  version: 1,
  ok: true,
  taskId: 'MotrixStartup',
  state,
  packageIdentityPresent: true,
})

function setup(
  input: DistributionContextInput = {
    platform: 'win32',
    isPackaged: true,
    windowsStore: true,
  }
) {
  const requestStartupTask = vi.fn().mockResolvedValue(result('disabled'))
  const setLoginItemSettings = vi.fn()
  return {
    ...createAutoLaunchService({
      getContext: () => input,
      requestStartupTask,
      setLoginItemSettings,
    }),
    requestStartupTask,
    setLoginItemSettings,
  }
}

describe('auto-launch service', () => {
  it.each(['win32', 'darwin'] as const)(
    'retains direct %s login items',
    async (platform) => {
      const service = setup({ platform, isPackaged: true })
      expect(await service.getAutoLaunchStatus()).toEqual({
        authority: 'application',
      })
      await service.syncAutoLaunch(true)
      await service.syncAutoLaunch(false)
      expect(service.setLoginItemSettings.mock.calls).toEqual([
        [{ openAtLogin: true, args: ['--opened-at-login=1'] }],
        [{ openAtLogin: false, args: [] }],
      ])
      expect(service.requestStartupTask).not.toHaveBeenCalled()
    }
  )

  it.each([
    { platform: 'linux', isPackaged: true },
    { platform: 'win32', isPackaged: false, windowsStore: true },
    { platform: 'darwin', isPackaged: false },
  ] satisfies DistributionContextInput[])(
    'does no system work for unsupported context %j',
    async (input) => {
      const service = setup(input)
      expect(await service.getAutoLaunchStatus()).toEqual({
        authority: 'unsupported',
      })
      await service.syncAutoLaunch(true)
      await service.syncAutoLaunch(false, 'startup')
      expect(service.requestStartupTask).not.toHaveBeenCalled()
      expect(service.setLoginItemSettings).not.toHaveBeenCalled()
    }
  )

  it('does not treat a windowsStore flag on macOS as package authority', async () => {
    const service = setup({
      platform: 'darwin',
      isPackaged: true,
      windowsStore: true,
    })
    expect(await service.getAutoLaunchStatus()).toEqual({
      authority: 'application',
    })
  })

  it.each([
    'disabled',
    'disabled_by_user',
    'enabled',
    'disabled_by_policy',
    'enabled_by_policy',
  ] as const)('queries %s without changing it at startup', async (state) => {
    const service = setup()
    service.requestStartupTask.mockResolvedValue(result(state))
    expect(await service.getAutoLaunchStatus()).toEqual({
      authority: 'windows-package',
      result: result(state),
    })
    await service.syncAutoLaunch(true, 'startup')
    await service.syncAutoLaunch(false, 'startup')
    expect(service.requestStartupTask.mock.calls).toEqual([
      ['startup_query'],
      ['startup_query'],
      ['startup_query'],
    ])
    expect(service.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it.each([
    [true, 'enabled'],
    [true, 'enabled_by_policy'],
    [false, 'disabled'],
    [false, 'disabled_by_user'],
    [false, 'disabled_by_policy'],
  ] as const)('accepts requested %s with actual %s', async (enabled, state) => {
    const service = setup()
    service.requestStartupTask.mockResolvedValue(result(state))
    await expect(service.syncAutoLaunch(enabled)).resolves.toBeUndefined()
    expect(service.requestStartupTask).toHaveBeenCalledExactlyOnceWith(
      enabled ? 'startup_enable' : 'startup_disable'
    )
    expect(service.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it.each([
    [true, 'disabled'],
    [true, 'disabled_by_user'],
    [true, 'disabled_by_policy'],
    [false, 'enabled'],
    [false, 'enabled_by_policy'],
  ] as const)(
    'reports unapplied intent %s when actual state is %s',
    async (enabled, state) => {
      const service = setup()
      service.requestStartupTask.mockResolvedValue(result(state))
      await expect(service.syncAutoLaunch(enabled)).rejects.toMatchObject({
        code: ErrorCode.AutoLaunchNotApplied,
        cause: result(state),
      })
      expect(service.setLoginItemSettings).not.toHaveBeenCalled()
    }
  )

  it('keeps query failures visible and wraps mutation failures without fallback', async () => {
    const service = setup()
    const failed = { version: 1, ok: false, code: 'helper_timeout' }
    service.requestStartupTask.mockResolvedValue(failed)
    expect(await service.getAutoLaunchStatus()).toEqual({
      authority: 'windows-package',
      result: failed,
    })
    for (const origin of ['startup', 'user'] as const) {
      await expect(service.syncAutoLaunch(true, origin)).rejects.toMatchObject({
        code: ErrorCode.AutoLaunchFailed,
        cause: failed,
      })
    }
    expect(service.setLoginItemSettings).not.toHaveBeenCalled()
  })

  it('normalizes unexpected backend rejection without inventing a state', async () => {
    const service = setup()
    service.requestStartupTask.mockRejectedValue(new Error('unexpected'))
    expect(await service.getAutoLaunchStatus()).toEqual({
      authority: 'windows-package',
      result: { version: 1, ok: false, code: 'helper_failed' },
    })
    await expect(service.syncAutoLaunch(true)).rejects.toBeInstanceOf(AppError)
  })

  it('translates traditional Electron failures to the same application error', async () => {
    const service = setup({ platform: 'win32', isPackaged: true })
    const cause = new Error('Electron failed')
    service.setLoginItemSettings.mockImplementation(() => {
      throw cause
    })
    await expect(service.syncAutoLaunch(true)).rejects.toMatchObject({
      code: ErrorCode.AutoLaunchFailed,
      cause,
    })
  })
})
