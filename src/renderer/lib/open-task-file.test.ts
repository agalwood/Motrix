import { toast } from '@renderer/components/ui/toast'
import { ErrorCode } from '@shared/errors'
import { Commands } from '@shared/protocol/commands'
import { TransportError } from '@shared/protocol/errors'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from './i18n'
import { openTaskFile } from './open-task-file'
import { transport } from './transport'

vi.mock('@renderer/components/ui/toast', () => ({ toast: { add: vi.fn() } }))
vi.mock('./transport', () => ({ transport: { invoke: vi.fn() } }))

beforeEach(() => vi.resetAllMocks())

describe('openTaskFile', () => {
  it('opens by task ID without showing an error on success', async () => {
    vi.mocked(transport.invoke).mockResolvedValueOnce(null)
    await openTaskFile('task-1', i18n.getFixedT('en-US'))
    expect(transport.invoke).toHaveBeenCalledExactlyOnceWith(
      Commands.OpenTaskFile,
      { taskId: 'task-1' }
    )
    expect(toast.add).not.toHaveBeenCalled()
  })

  it.each([
    [
      'en-US',
      'Could not open file',
      'The system could not open this file. Check that its default app is still installed, or use Open folder to choose another app.',
    ],
    [
      'zh-CN',
      '无法打开文件',
      '系统无法打开此文件。请检查默认应用是否仍已安装，或通过“打开文件夹”选择其他应用打开。',
    ],
  ])(
    'explains OS open failures in %s without displaying IPC internals',
    async (locale, title, description) => {
      vi.mocked(transport.invoke).mockRejectedValueOnce(
        new TransportError(
          ErrorCode.TaskOpenAppFailed,
          'The application is missing (-10814)'
        )
      )
      await openTaskFile('task-1', i18n.getFixedT(locale))
      expect(toast.add).toHaveBeenCalledExactlyOnceWith({
        title,
        description,
        type: 'error',
      })
    }
  )

  it.each([
    new TransportError(ErrorCode.TaskOpenFailed, 'ENOENT'),
    new Error(
      "Error invoking remote method 'command:openTaskFile': AppError: Task output could not be opened"
    ),
  ])(
    'does not misidentify other failures as app association failures: %s',
    async (error) => {
      vi.mocked(transport.invoke).mockRejectedValueOnce(error)
      await openTaskFile('task-1', i18n.getFixedT('en-US'))
      expect(toast.add).toHaveBeenCalledExactlyOnceWith({
        title: 'Could not open file',
        description:
          'Check that the file still exists and you have permission to open it.',
        type: 'error',
      })
    }
  )
})
