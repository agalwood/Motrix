import { makeDefaultBtExtension, TaskType } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it } from 'vitest'
import {
  slimTaskForBroadcast,
  slimTasksForBroadcast,
} from './slim-task-for-broadcast'

function makeBtTask() {
  const task = makeDownloadTask({
    id: 'bt-1',
    type: TaskType.Bt,
  })
  task.bt = makeDefaultBtExtension({
    trackers: ['udp://a:1/announce', 'udp://b:1/announce'],
    announceList: [['udp://a:1/announce'], ['udp://b:1/announce']],
    magnetUri: 'magnet:?xt=urn:btih:abc',
    peers: 7,
  })
  return task
}

describe('slimTaskForBroadcast', () => {
  it('drops the three static BT fields and keeps the rest of bt', () => {
    const task = makeBtTask()

    const slim = slimTaskForBroadcast(task)

    expect(slim.bt?.trackers).toEqual([])
    expect(slim.bt?.announceList).toEqual([])
    expect(slim.bt?.magnetUri).toBeNull()
    expect(slim.bt?.peers).toBe(7)
  })

  it('never mutates the stored task', () => {
    const task = makeBtTask()

    slimTaskForBroadcast(task)

    expect(task.bt?.trackers).toHaveLength(2)
    expect(task.bt?.announceList).toHaveLength(2)
    expect(task.bt?.magnetUri).toBe('magnet:?xt=urn:btih:abc')
  })

  it('returns non-BT and already-slim tasks by reference', () => {
    const http = makeDownloadTask({ id: 'http-1' })
    expect(slimTaskForBroadcast(http)).toBe(http)

    const slimBt = makeDownloadTask({ id: 'bt-2', type: TaskType.Bt })
    slimBt.bt = makeDefaultBtExtension({})
    expect(slimTaskForBroadcast(slimBt)).toBe(slimBt)
  })

  it('slims a whole snapshot', () => {
    const tasks = [makeBtTask(), makeDownloadTask({ id: 'http-1' })]

    const slim = slimTasksForBroadcast(tasks)

    expect(slim[0]?.bt?.announceList).toEqual([])
    expect(slim[1]).toBe(tasks[1])
  })
})
