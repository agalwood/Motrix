import { Commands } from '@shared/protocol/commands'
import type { CommandHandlerMap } from '@shared/protocol/handler-types'
import { TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { expect, it, vi } from 'vitest'
import type { ServerDownloadPathPolicy } from '../../download-path-policy'
import type { NasFiles } from './files'
import { guardNasTaskCommands } from './task-commands'

it('does not resume tasks after their download authorization is revoked', async () => {
  const resume = vi.fn()
  const handlers: CommandHandlerMap = { [Commands.ResumeAllTasks]: resume }
  const policy = {
    prepareSaveDir: vi.fn().mockRejectedValue(new Error('revoked')),
  } as unknown as ServerDownloadPathPolicy
  const files = { check: vi.fn() } as unknown as NasFiles
  guardNasTaskCommands(handlers, files, policy, () => [
    makeDownloadTask({ status: TaskStatus.Paused, saveDir: '/volume/private' }),
  ])
  await expect(handlers[Commands.ResumeAllTasks]?.()).rejects.toThrow('revoked')
  expect(resume).not.toHaveBeenCalled()
})
