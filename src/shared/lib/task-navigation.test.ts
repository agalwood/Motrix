import { TaskStatus } from '@shared/types/task'
import { describe, expect, it } from 'vitest'
import { isTaskAvailable, resolveTaskRoute } from './task-navigation'

describe('task navigation', () => {
  it.each([null, undefined, TaskStatus.Removed])(
    'falls back to all downloads when the current task status is %s',
    (status) => {
      expect(isTaskAvailable(status)).toBe(false)
      expect(resolveTaskRoute('t-1', status)).toBe('/downloads/all')
    }
  )

  it.each(
    Object.values(TaskStatus).filter((status) => status !== TaskStatus.Removed)
  )('preserves task navigation for an existing %s task', (status) => {
    expect(isTaskAvailable(status)).toBe(true)
    expect(resolveTaskRoute('task/?#1', status)).toBe(
      '/downloads/all?task=task%2F%3F%231'
    )
  })
})
