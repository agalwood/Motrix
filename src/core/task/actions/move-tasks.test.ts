import { TaskKind, TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it, vi } from 'vitest'
import { moveTasks } from './move-tasks'
import type { TaskActionDeps } from './shared'

function setup(order = ['a', 'b', 'c', 'd', 'e']) {
  const queue = [...order]
  const tasks = new Map(
    order.map((id) => [
      id,
      makeDownloadTask({
        id,
        engineTaskId: id,
        status: TaskStatus.Paused,
      }),
    ])
  )
  const changePosition = vi.fn(
    async (id: string, shift: number, how: string) => {
      const index = queue.indexOf(id)
      const destination = Math.max(
        0,
        Math.min(queue.length - 1, how === 'POS_SET' ? shift : index + shift)
      )
      queue.splice(index, 1)
      queue.splice(destination, 0, id)
      return destination
    }
  )
  const listWaitingTaskIds = vi.fn(async () => [...queue])
  const deps = {
    adapter: { changePosition, listWaitingTaskIds },
    taskManager: { getById: (id: string) => tasks.get(id) },
    log: { warn: vi.fn() },
  } as unknown as TaskActionDeps
  return { deps, tasks, queue, changePosition, listWaitingTaskIds }
}

describe('moveTasks', () => {
  it.each(['top', 'bottom'] as const)(
    'moves every subset to the %s without changing relative order',
    async (direction) => {
      const original = ['a', 'b', 'c', 'd', 'e']
      for (let mask = 1; mask < 32; mask++) {
        const selected = original.filter((_, index) => mask & (1 << index))
        const rest = original.filter((id) => !selected.includes(id))
        const { deps, queue, changePosition } = setup()
        const expected =
          direction === 'top' ? [...selected, ...rest] : [...rest, ...selected]
        const result = await moveTasks(
          { taskIds: [...selected].reverse(), direction },
          deps
        )
        expect(queue).toEqual(expected)
        expect(result.failed).toEqual([])
        expect(
          changePosition.mock.calls.every((call) => call[2] === 'POS_SET')
        ).toBe(true)
      }
    }
  )

  it.each(['top', 'bottom'] as const)(
    'does not cross a failed selected task when moving to the %s',
    async (direction) => {
      const { deps, queue, changePosition } = setup()
      changePosition.mockRejectedValueOnce(new Error('engine unavailable'))
      const result = await moveTasks({ taskIds: ['b', 'd'], direction }, deps)
      expect(queue).toEqual(
        direction === 'top'
          ? ['a', 'b', 'd', 'c', 'e']
          : ['a', 'c', 'b', 'd', 'e']
      )
      expect(result.failed).toHaveLength(1)
      expect(queue.filter((id) => ['b', 'd'].includes(id))).toEqual(['b', 'd'])
    }
  )
  it.each(['up', 'down'] as const)(
    'keeps relative order for every subset moving %s',
    async (direction) => {
      const original = ['a', 'b', 'c', 'd', 'e']
      for (let mask = 1; mask < 32; mask++) {
        const selected = original.filter((_, index) => mask & (1 << index))
        const { deps, queue } = setup()
        const expected = [...original]
        const scan =
          direction === 'up' ? [...selected] : [...selected].reverse()
        for (const id of scan) {
          const index = expected.indexOf(id)
          const destination = index + (direction === 'up' ? -1 : 1)
          if (
            destination < 0 ||
            destination >= expected.length ||
            selected.includes(expected[destination])
          )
            continue
          ;[expected[index], expected[destination]] = [
            expected[destination],
            expected[index],
          ]
        }
        // Visible column order / click order must have no influence.
        const result = await moveTasks(
          { taskIds: [...selected].reverse(), direction },
          deps
        )
        expect(queue).toEqual(expected)
        expect(queue.filter((id) => selected.includes(id))).toEqual(selected)
        expect(result.failed).toEqual([])
      }
    }
  )

  it('deduplicates targets and never moves tasks that are active or managed by a coordinator', async () => {
    const { deps, tasks, queue, changePosition } = setup()
    tasks.set('a', { ...tasks.get('a')!, status: TaskStatus.Downloading })
    tasks.set('b', { ...tasks.get('b')!, kind: TaskKind.Hls })
    const result = await moveTasks(
      { taskIds: ['a', 'b', 'c', 'c', 'missing'], direction: 'up' },
      deps
    )
    expect(queue).toEqual(['a', 'c', 'b', 'd', 'e'])
    expect(changePosition).toHaveBeenCalledTimes(1)
    expect(result.moved).toEqual(['c'])
    expect(result.failed.map((entry) => entry.taskId)).toEqual([
      'a',
      'b',
      'missing',
    ])
  })

  it('does not cross a selected neighbor whose move failed', async () => {
    const { deps, queue, changePosition } = setup()
    changePosition.mockRejectedValueOnce(new Error('engine unavailable'))
    const result = await moveTasks(
      { taskIds: ['b', 'c'], direction: 'up' },
      deps
    )
    expect(queue).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(result.failed).toEqual([{ taskId: 'b', reason: 'engine-rejected' }])
    expect(result.unchanged).toEqual(['c'])
  })

  it('revalidates a task that started after the initial queue read', async () => {
    const { deps, queue, listWaitingTaskIds, changePosition } = setup()
    listWaitingTaskIds.mockImplementationOnce(async () => {
      const before = [...queue]
      queue.splice(queue.indexOf('b'), 1)
      return before
    })
    const result = await moveTasks({ taskIds: ['b'], direction: 'up' }, deps)
    expect(result.failed).toEqual([{ taskId: 'b', reason: 'not-waiting' }])
    expect(changePosition).not.toHaveBeenCalled()
  })

  it('serializes concurrent batches sharing an engine', async () => {
    const { deps, queue } = setup()
    await Promise.all([
      moveTasks({ taskIds: ['c', 'd'], direction: 'up' }, deps),
      moveTasks({ taskIds: ['c', 'd'], direction: 'up' }, deps),
    ])
    expect(queue).toEqual(['c', 'd', 'a', 'b', 'e'])
  })
})
