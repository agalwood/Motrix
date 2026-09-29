import type { EngineAdapter } from '@core/engine/engine-adapter'
import { TaskManager } from '@core/task/task-manager'
import type { TaskTrackerState } from '@shared/schemas/task-tracker'
import { makeDefaultBtExtension, TaskStatus } from '@shared/types/task'
import { makeDownloadTask } from '@test-utils/task'
import parseTorrent from 'parse-torrent'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskTrackerService } from './task-tracker-service'

vi.mock('parse-torrent', () => ({ default: vi.fn() }))
const a = 'udp://a.example:80/announce'
const b = 'https://b.example/announce?passkey=Secret'
const c = 'https://c.example/announce'
const native = 'https://native.example/announce'

function fixture(initial: string[] = [a, b]) {
  let selected = [c]
  let effective = [...initial]
  let state: TaskTrackerState | null = {
    engineGid: '1234567890abcdef',
    revision: 1,
    original: [native],
    manual: [b],
    managed: [a],
    excluded: [],
    isPrivate: false,
    pending: null,
  }
  const tasks = new TaskManager()
  const task = makeDownloadTask({
    id: 'task',
    engineTaskId: '1234567890abcdef',
    status: TaskStatus.Downloading,
  })
  tasks.add(task)
  const repository = {
    get: vi.fn(() => state && structuredClone(state)),
    save: vi.fn((_id: string, value: TaskTrackerState) => {
      state = structuredClone(value)
    }),
    pendingTaskIds: () => (state?.pending ? ['task'] : []),
  }
  const adapter = {
    getTaskBtTracker: vi.fn(async () => [...effective]),
    getTaskStatus: vi.fn(async () => task),
    setTaskBtTracker: vi.fn(async (_gid: string, urls: string[]) => {
      effective = [...urls]
    }),
  }
  const actions = {
    pauseTask: vi.fn(async () => {
      task.status = TaskStatus.Paused
    }),
    resumeTask: vi.fn(async () => {
      task.status = TaskStatus.Downloading
    }),
  }
  const deps = {
    adapter: adapter as unknown as EngineAdapter,
    tasks,
    repository,
    selected: () => selected,
    actions,
  }
  const service = new TaskTrackerService(deps)
  const plan = () => service.plan(task.id, task.engineTaskId)
  const apply = async () =>
    service.apply(task.id, task.engineTaskId, (await plan()).fingerprint)
  return {
    service,
    deps,
    task,
    tasks,
    repository,
    adapter,
    actions,
    plan,
    apply,
    state: () => state,
    setState: (value: TaskTrackerState | null) => {
      state = value
    },
    effective: () => effective,
    setEffective: (value: string[]) => {
      effective = value
    },
    select: (value: string[]) => {
      selected = value
    },
  }
}

beforeEach(() => {
  vi.mocked(parseTorrent).mockReset()
})

describe('task tracker ownership and journal', () => {
  it('previews only managed removal, preserves manual and native overlap, then resumes', async () => {
    const f = fixture([a, b, native])
    const plan = await f.plan()
    expect(plan).toMatchObject({
      added: [c],
      removed: [a],
      retained: [b, native],
      requiresPause: true,
    })
    expect(f.adapter.setTaskBtTracker).not.toHaveBeenCalled()
    await f.service.apply('task', f.task.engineTaskId, plan.fingerprint)
    expect(f.effective()).toEqual([b, native, c])
    expect(f.state()).toMatchObject({ managed: [c], pending: null })
    expect(f.actions.pauseTask).toHaveBeenCalledOnce()
    expect(f.actions.resumeTask).toHaveBeenCalledOnce()
  })
  it('does not misclassify supplemental URLs in aria2 announceList as native metadata', async () => {
    const f = fixture([a, b])
    f.task.bt = makeDefaultBtExtension({ announceList: [[native, a, b]] })
    expect(await f.plan()).toMatchObject({
      original: [native],
      removed: [a],
      added: [c],
    })
    await f.service.edit('task', f.task.engineTaskId, [b])
    expect(f.effective()).toEqual([b])
  })

  it('never guesses legacy ownership from global membership', async () => {
    const f = fixture()
    f.setState(null)
    f.task.torrentMetaPath = '/seed.torrent'
    const plan = await f.plan()
    expect(plan.removed).toEqual([])
    expect(plan.retained).toEqual([a, b])
  })
  it('keeps managed/manual overlap when that URL leaves selection', async () => {
    const f = fixture()
    f.setState({ ...f.state()!, manual: [a, b] })
    expect((await f.plan()).removed).toEqual([])
  })
  it('persists manual deletion as an exclusion through later sync and re-add', async () => {
    const f = fixture()
    f.select([a, c])
    await f.service.edit('task', f.task.engineTaskId, [b])
    expect(f.state()?.excluded).toEqual([a])
    await f.apply()
    expect(f.effective()).toEqual([b, c])
    vi.mocked(parseTorrent).mockResolvedValue({
      private: false,
      announce: [native],
    } as never)
    const prepared = await f.service.prepareCreation({
      engineGid: f.task.engineTaskId,
      metadata: new Uint8Array([1]),
      manual: [],
    })
    expect(prepared.trackers).toEqual([b, c])
  })
  it('an explicit re-add of an excluded URL makes it manual', async () => {
    const f = fixture()
    f.setState({ ...f.state()!, managed: [], excluded: [a] })
    f.setEffective([b])
    await f.service.edit('task', f.task.engineTaskId, [a, b])
    expect(f.state()).toMatchObject({ excluded: [], manual: [a, b] })
    expect((await f.plan()).removed).toEqual([])
  })
  it('rejects stale selection, engine options, or active-state previews before pausing', async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => f.select([a]),
      (f: ReturnType<typeof fixture>) => f.setEffective([a]),
      (f: ReturnType<typeof fixture>) => {
        f.task.status = TaskStatus.Paused
      },
    ]) {
      const f = fixture()
      const plan = await f.plan()
      change(f)
      await expect(
        f.service.apply('task', f.task.engineTaskId, plan.fingerprint)
      ).rejects.toThrow('stale')
      expect(f.actions.pauseTask).not.toHaveBeenCalled()
      expect(f.adapter.setTaskBtTracker).not.toHaveBeenCalled()
    }
  })
  it('does not pause an already-paused task or resume it after applying', async () => {
    const f = fixture()
    f.task.status = TaskStatus.Paused
    await f.apply()
    expect(f.actions.pauseTask).not.toHaveBeenCalled()
    expect(f.actions.resumeTask).not.toHaveBeenCalled()
  })
  it('does not pause or write for an unchanged plan', async () => {
    const f = fixture()
    f.select([a])
    await f.apply()
    expect(f.adapter.setTaskBtTracker).not.toHaveBeenCalled()
    expect(f.actions.pauseTask).not.toHaveBeenCalled()
  })
  it('records intent before pausing and compensates even if pause rejects after taking effect', async () => {
    const f = fixture()
    f.actions.pauseTask.mockImplementationOnce(async () => {
      expect(f.state()?.pending).toMatchObject({
        before: [a, b],
        after: [b, c],
        resumeRequired: true,
      })
      f.task.status = TaskStatus.Paused
      throw new Error('pause acknowledgement lost')
    })
    await expect(f.apply()).rejects.toThrow('pause acknowledgement lost')
    expect(f.actions.resumeTask).toHaveBeenCalledOnce()
    expect(f.adapter.setTaskBtTracker).not.toHaveBeenCalled()
    expect(f.state()).toMatchObject({ managed: [a], pending: null })
  })
  it('verifies applied options after a lost write response', async () => {
    const f = fixture()
    f.adapter.setTaskBtTracker.mockImplementationOnce(async (_gid, urls) => {
      f.setEffective(urls)
      throw new Error('lost response')
    })
    await expect(f.apply()).rejects.toThrow('lost response')
    expect(f.state()?.lastError?.phase).toBe('write')
    expect(f.state()).toMatchObject({ managed: [c], pending: null })
    expect(f.actions.resumeTask).toHaveBeenCalledOnce()
  })
  it('retains a journal across resume failure and recovers idempotently in a new service', async () => {
    const f = fixture()
    f.actions.resumeTask.mockRejectedValueOnce(new Error('offline'))
    await expect(f.apply()).rejects.toThrow('offline')
    expect(f.state()?.pending).not.toBeNull()
    const restarted = new TaskTrackerService(f.deps)
    await restarted.recover()
    await restarted.recover()
    expect(f.state()).toMatchObject({ managed: [c], pending: null })
    expect(f.adapter.setTaskBtTracker).toHaveBeenCalledOnce()
    expect(f.actions.resumeTask).toHaveBeenCalledTimes(2)
  })
  it('surrenders ambiguous ownership after an external engine edit during recovery', async () => {
    const f = fixture()
    f.adapter.setTaskBtTracker.mockImplementationOnce(async () => {
      f.setEffective([b, native])
      throw new Error('external change')
    })
    await expect(f.apply()).rejects.toThrow()
    expect(f.state()).toMatchObject({
      managed: [],
      manual: [b, native],
      pending: null,
    })
  })
  it('never resumes a replacement generation or overwrites its options', async () => {
    const f = fixture()
    f.actions.pauseTask.mockImplementationOnce(async () => {
      f.task.engineTaskId = 'fedcba0987654321'
    })
    await expect(f.apply()).rejects.toThrow('changed')
    expect(f.adapter.setTaskBtTracker).not.toHaveBeenCalled()
    expect(f.actions.resumeTask).not.toHaveBeenCalled()
  })
  it('retains pending state while engine is missing instead of treating [] as success', async () => {
    const f = fixture()
    f.adapter.getTaskStatus
      .mockResolvedValueOnce(f.task)
      .mockResolvedValueOnce(null as never)
    await expect(f.apply()).rejects.toThrow('unavailable')
    expect(f.state()?.pending).not.toBeNull()
    await f.service.recover()
    expect(f.state()?.pending).toBeNull()
  })
  it('private and unknown tasks receive no selection, including private metadata overriding false flags', async () => {
    for (const privacy of [true, null]) {
      const f = fixture()
      f.setState({ ...f.state()!, isPrivate: privacy })
      expect((await f.plan()).added).toEqual([])
    }
    const f = fixture()
    vi.mocked(parseTorrent).mockResolvedValue({
      private: true,
      announce: [native],
    } as never)
    expect(
      await f.service.prepareCreation({
        engineGid: f.task.engineTaskId,
        metadata: new Uint8Array([1]),
        manual: [c],
        isPrivate: false,
      })
    ).toEqual({ trackers: [], isPrivate: true })
    expect(f.state()).toMatchObject({
      managed: [],
      manual: [],
      original: [native],
      isPrivate: true,
    })
  })
  it('restores explicit manual edits made to an already-confirmed private task', async () => {
    const f = fixture()
    f.setState({ ...f.state()!, isPrivate: true, managed: [] })
    vi.mocked(parseTorrent).mockResolvedValue({
      private: true,
      announce: [native],
    } as never)
    const restored = await f.service.prepareCreation({
      engineGid: f.task.engineTaskId,
      metadata: new Uint8Array([1]),
      manual: [c],
      isPrivate: true,
    })
    expect(restored).toEqual({ trackers: [b], isPrivate: true })
    expect(f.state()?.managed).toEqual([])
  })

  it('unknown magnets and malformed metadata never inherit public supplements', async () => {
    const f = fixture([])
    f.setState(null)
    expect(
      await f.service.prepareCreation({
        engineGid: f.task.engineTaskId,
        manual: [],
      })
    ).toEqual({ trackers: [], isPrivate: false })
    vi.mocked(parseTorrent).mockRejectedValueOnce(new Error('invalid'))
    expect(
      (
        await f.service.prepareCreation({
          engineGid: f.task.engineTaskId,
          metadata: new Uint8Array(),
          manual: [],
        })
      ).trackers
    ).toEqual([])
  })
  it('keeps native metadata addresses outside the supplemental cap and preserves manual credentials', async () => {
    const f = fixture()
    f.select([native, c])
    vi.mocked(parseTorrent).mockResolvedValue({
      private: false,
      announce: [native],
    } as never)
    expect(
      (
        await f.service.prepareCreation({
          engineGid: f.task.engineTaskId,
          metadata: new Uint8Array([1]),
          manual: [],
        })
      ).trackers
    ).toEqual([b, c])
    expect(f.state()?.pending?.next.original).toEqual([native])
  })
  it('honors an explicit user pause while applying instead of auto-resuming over it', async () => {
    const f = fixture()
    f.adapter.setTaskBtTracker.mockImplementationOnce(async (_gid, urls) => {
      f.service.noteTaskControl('task', true)
      f.setEffective(urls)
    })
    await f.apply()
    expect(f.actions.resumeTask).not.toHaveBeenCalled()
    expect(f.task.status).toBe(TaskStatus.Paused)
    expect(f.state()).toMatchObject({ managed: [c], pending: null })
  })

  it('serializes edits with sync and drains accepted work at shutdown', async () => {
    const f = fixture()
    const first = f.service.edit('task', f.task.engineTaskId, [b])
    const second = f.service.edit('task', f.task.engineTaskId, [b, c])
    await f.service.stopAndDrain()
    await first
    await second
    expect(f.effective()).toEqual([b, c])
    await expect(f.plan()).rejects.toThrow('stopped')
  })
})
