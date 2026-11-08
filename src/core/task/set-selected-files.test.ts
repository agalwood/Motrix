import { EventBus } from '@core/events/event-bus'
import { TaskKind, TaskType } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { expect, it, vi } from 'vitest'
import { createSetSelectedFilesHandler } from './set-selected-files'
import { TaskManager } from './task-manager'

it('checks output authorization under the mutation lock before changing selected files', async () => {
  const tasks = new TaskManager()
  const task = makeDownloadTask({ kind: TaskKind.Bt, type: TaskType.Bt })
  tasks.add(task)
  const engine = {
    changeOption: vi.fn(async () => {}),
    getTaskFiles: vi.fn(async () => []),
  }
  const db = { replaceTaskFiles: vi.fn() }
  let locked = false
  const handler = createSetSelectedFilesHandler({
    taskManager: tasks,
    engine,
    db,
    eventBus: new EventBus(),
    runTaskMutation: async (_ids, operation) => {
      locked = true
      try {
        return await operation()
      } finally {
        locked = false
      }
    },
    authorizeTaskWrite: async (current) => {
      expect(locked).toBe(true)
      expect(current).toBe(task)
      throw new Error('revoked')
    },
  })
  await expect(handler({ taskId: task.id, indices: [0] })).rejects.toThrow(
    'revoked'
  )
  expect(engine.changeOption).not.toHaveBeenCalled()
  expect(db.replaceTaskFiles).not.toHaveBeenCalled()
})
