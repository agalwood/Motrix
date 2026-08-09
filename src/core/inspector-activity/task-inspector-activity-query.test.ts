import { ErrorCode } from '@shared/errors'
import { makeTaskInspectorActivitySnapshot } from '@test-utils/task-inspector-activity'
import { describe, expect, it, vi } from 'vitest'
import { createTaskInspectorActivityQuery } from './task-inspector-activity-query'
import { MAX_TASK_ID_LENGTH } from './validators'

describe('createTaskInspectorActivityQuery', () => {
  it('validates the public task id and delegates to the runtime', () => {
    const snapshot = vi.fn((taskId: string) =>
      makeTaskInspectorActivitySnapshot(taskId)
    )
    const query = createTaskInspectorActivityQuery({ snapshot })

    expect(query.snapshot({ taskId: 'task-1' })).toEqual(
      makeTaskInspectorActivitySnapshot('task-1')
    )
    expect(snapshot).toHaveBeenCalledWith('task-1')
    expect(() => query.snapshot({ taskId: '' })).toThrow(
      'Invalid Task Inspector Activity query params'
    )
    expect(() =>
      query.snapshot({
        taskId: 'task-1',
        unexpected: true,
      })
    ).toThrow('Invalid Task Inspector Activity query params')
    expect(() =>
      query.snapshot({ taskId: 'x'.repeat(MAX_TASK_ID_LENGTH + 1) })
    ).toThrow('Invalid Task Inspector Activity query params')
    expect(() =>
      query.snapshot({
        taskId: `${' '.repeat(MAX_TASK_ID_LENGTH + 1)}task-1`,
      })
    ).toThrow('Invalid Task Inspector Activity query params')
  })

  it.each([null, undefined])(
    'throws the shared TaskNotFound AppError for an absent %s snapshot',
    (snapshot) => {
      const query = createTaskInspectorActivityQuery({
        snapshot: () => snapshot,
      })

      expect(() => query.snapshot({ taskId: 'missing' })).toThrow(
        expect.objectContaining({
          code: ErrorCode.TaskNotFound,
          message: 'Task not found: missing',
        })
      )
    }
  )

  it('supports a deterministic test seam that fails after the first query', () => {
    const snapshot = vi.fn((taskId: string) =>
      makeTaskInspectorActivitySnapshot(taskId)
    )
    const query = createTaskInspectorActivityQuery(
      { snapshot },
      { failAfterFirstQuery: true }
    )

    expect(query.snapshot({ taskId: 'task-1' })).toEqual(
      makeTaskInspectorActivitySnapshot('task-1')
    )
    expect(() => query.snapshot({ taskId: 'task-1' })).toThrow(
      'deterministic Task Inspector Activity query failure'
    )
    expect(snapshot).toHaveBeenCalledOnce()
  })

  it.each([
    {
      label: 'a nested NaN',
      value: {
        ...makeTaskInspectorActivitySnapshot('poison'),
        lifetime: {
          ...makeTaskInspectorActivitySnapshot('poison').lifetime,
          points: [{ t: 1, down: Number.NaN, up: 0, flags: 0 }],
        },
      },
    },
    {
      label: 'a BigInt field',
      value: {
        ...makeTaskInspectorActivitySnapshot('poison'),
        revision: 1n,
      },
    },
    {
      label: 'a function field',
      value: {
        ...makeTaskInspectorActivitySnapshot('poison'),
        summary: () => undefined,
      },
    },
  ])('rejects poisoned reader output containing $label', ({ value }) => {
    const query = createTaskInspectorActivityQuery({
      snapshot: () => value,
    })

    expect(() => query.snapshot({ taskId: 'poison' })).toThrow(
      'Invalid Task Inspector Activity snapshot'
    )
  })

  it('rejects circular reader output before a transport serializes it', () => {
    const value = makeTaskInspectorActivitySnapshot('circular') as ReturnType<
      typeof makeTaskInspectorActivitySnapshot
    > & {
      self?: unknown
    }
    value.self = value
    const query = createTaskInspectorActivityQuery({
      snapshot: () => value,
    })

    expect(() => query.snapshot({ taskId: 'circular' })).toThrow(
      'Invalid Task Inspector Activity snapshot'
    )
  })
})
