import type { DownloadTask } from '@shared/types/task'
import { TaskStatus, TaskType } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import { describe, expect, it } from 'vitest'
import {
  applyFilter,
  countTasksByTab,
  countTasksByType,
  DOWNLOADS_TABS,
  isValidTab,
  parseTypeParam,
  serializeTypeParam,
  taskMatchesQuery,
  taskMatchesTab,
} from './filter'

function fake(overrides: Partial<DownloadTask> = {}): DownloadTask {
  return makeDownloadTask({
    id: 't',
    engineTaskId: 'g',
    name: 'demo.iso',
    progress: 0.5,
    totalBytes: 1000,
    downloadedBytes: 500,
    saveDir: '/tmp',
    uris: ['https://example.com/demo.iso'],
    fileCount: 1,
    filename: 'demo.iso',
    sizeWhenDone: 1000,
    diskPath: '/tmp/demo.iso',
    finalPath: '/tmp/demo.iso',
    finalName: 'demo.iso',
    ...overrides,
  })
}

describe('isValidTab', () => {
  it('accepts the four known tabs', () => {
    for (const t of DOWNLOADS_TABS) expect(isValidTab(t)).toBe(true)
  })
  it.each(['', 'nope', undefined, null, 42])('rejects %j', (v) => {
    expect(isValidTab(v)).toBe(false)
  })
})

describe('taskMatchesTab', () => {
  it('all excludes Removed', () => {
    expect(taskMatchesTab(fake({ status: TaskStatus.Removed }), 'all')).toBe(
      false
    )
    expect(taskMatchesTab(fake({ status: TaskStatus.Completed }), 'all')).toBe(
      true
    )
  })
  it('active matches the shared task-view policy', () => {
    expect(taskMatchesTab(fake({ status: TaskStatus.Paused }), 'active')).toBe(
      true
    )
    expect(taskMatchesTab(fake({ status: TaskStatus.Seeding }), 'active')).toBe(
      true
    )
    expect(
      taskMatchesTab(fake({ status: TaskStatus.MetadataReady }), 'active')
    ).toBe(true)
    expect(
      taskMatchesTab(fake({ status: TaskStatus.Completed }), 'active')
    ).toBe(false)
    expect(taskMatchesTab(fake({ status: TaskStatus.Error }), 'active')).toBe(
      false
    )
  })
})

describe('applyFilter (tab + types)', () => {
  const tasks = [
    fake({ id: 'a', type: TaskType.Http, status: TaskStatus.Downloading }),
    fake({ id: 'b', type: TaskType.Magnet, status: TaskStatus.Paused }),
    fake({ id: 'c', type: TaskType.Bt, status: TaskStatus.Completed }),
  ]
  it('empty types = all types pass (tab still applies)', () => {
    expect(applyFilter(tasks, 'active', []).map((t) => t.id)).toEqual([
      'a',
      'b',
    ])
  })
  it('single type narrows', () => {
    expect(
      applyFilter(tasks, 'all', [TaskType.Magnet]).map((t) => t.id)
    ).toEqual(['b'])
  })
  it('multiple types are OR-combined', () => {
    expect(
      applyFilter(tasks, 'all', [TaskType.Http, TaskType.Bt]).map((t) => t.id)
    ).toEqual(['a', 'c'])
  })
  it('type AND tab', () => {
    expect(
      applyFilter(tasks, 'active', [TaskType.Bt]).map((t) => t.id)
    ).toEqual([])
  })
})

describe('countTasksByTab', () => {
  it('uses Motrix task statuses for all footer and title counts', () => {
    expect(
      countTasksByTab([
        fake({ id: 'paused', status: TaskStatus.Paused }),
        fake({ id: 'completed', status: TaskStatus.Completed }),
        fake({ id: 'error', status: TaskStatus.Error }),
        fake({ id: 'removed', status: TaskStatus.Removed }),
      ])
    ).toEqual({ all: 3, active: 1, completed: 1, error: 1 })
  })
})

describe('countTasksByType', () => {
  it('counts per type ignoring Removed', () => {
    const counts = countTasksByType([
      fake({ type: TaskType.Http }),
      fake({ type: TaskType.Http }),
      fake({ type: TaskType.Bt }),
      fake({ type: TaskType.Metalink }),
      fake({ type: TaskType.Http, status: TaskStatus.Removed }),
    ])
    expect(counts[TaskType.Http]).toBe(2)
    expect(counts[TaskType.Bt]).toBe(1)
    expect(counts[TaskType.Metalink]).toBe(1)
    expect(counts[TaskType.Ftp]).toBe(0)
  })
})

describe('parse/serialize type param', () => {
  it('parses a comma list, dropping unknowns and dupes', () => {
    expect(parseTypeParam('http,bt,nope,http')).toEqual([
      TaskType.Http,
      TaskType.Bt,
    ])
  })
  it('null / empty parse to []', () => {
    expect(parseTypeParam(null)).toEqual([])
    expect(parseTypeParam('')).toEqual([])
  })
  it('serialize joins on comma', () => {
    expect(serializeTypeParam([TaskType.Http, TaskType.Magnet])).toBe(
      'http,magnet'
    )
    expect(serializeTypeParam([])).toBe('')
  })
})

describe('taskMatchesQuery (finder)', () => {
  const t = fake({
    name: 'Ubuntu 24.04',
    uris: ['https://example.com/u.iso'],
    category: 'iso',
  })
  it('empty needle matches everything', () => {
    expect(taskMatchesQuery(t, '   ')).toBe(true)
  })
  it('matches name case-insensitively', () => {
    expect(taskMatchesQuery(t, 'UBUNTU')).toBe(true)
  })
  it('matches uri and category', () => {
    expect(taskMatchesQuery(t, 'example.com')).toBe(true)
    expect(taskMatchesQuery(t, 'iso')).toBe(true)
  })
  it('non-match returns false', () => {
    expect(taskMatchesQuery(t, 'fedora')).toBe(false)
  })
})
