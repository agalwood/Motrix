import { randomUUID } from 'node:crypto'
import { EventBus } from '@core/events/event-bus'
import { Events } from '@shared/protocol/events'
import { TaskStatus } from '@shared/types/task'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { setupEventForwarding } from '../ipc/events'
import { RendererIntents } from './renderer-intents'
import type { WindowManager } from './window-manager'

function fixture() {
  let ready = false
  let generation = randomUUID()
  const send = vi.fn()
  const statuses = new Map<string, TaskStatus>()
  const win = {
    isDestroyed: () => false,
    webContents: { send },
  } as unknown as BrowserWindow
  const intents = new RendererIntents({
    window: () => win,
    session: () => ({ generation }),
    ready: () => ready,
    isMagnetSelectionPending: (taskId) =>
      statuses.get(taskId) === TaskStatus.MetadataReady,
  })
  return {
    intents,
    send,
    win,
    setTaskStatus: (taskId: string, status?: TaskStatus) => {
      if (status) statuses.set(taskId, status)
      else statuses.delete(taskId)
    },
    unavailable: () => {
      ready = false
    },
    ready: () => {
      ready = true
    },
    generation: () => generation,
    reload: () => {
      generation = randomUUID()
    },
  }
}
describe('RendererIntents', () => {
  it('does not replay a magnet selection settled while its renderer was unavailable', () => {
    const f = fixture()
    const bus = new EventBus()
    const windows = {
      get: () => f.win,
      show: vi.fn(),
      broadcast: vi.fn(),
    } as unknown as WindowManager
    setupEventForwarding(bus, windows, () => [], f.intents)
    f.ready()
    const payload = { taskId: 'metadata-task' }
    f.setTaskStatus(payload.taskId, TaskStatus.MetadataReady)
    bus.emit(Events.MagnetFileSelection, payload)
    expect(f.send).toHaveBeenCalledOnce()
    const first = f.send.mock.calls[0][1]
    f.intents.acknowledge('add-task', f.generation(), first.id)
    f.unavailable()
    bus.emit(Events.MagnetFileSelectionSettled, {
      taskId: payload.taskId,
      downloadTaskId: payload.taskId,
    })
    f.reload()
    f.ready()
    f.intents.flush('add-task')
    expect(f.send).toHaveBeenCalledOnce()
    expect(windows.broadcast).toHaveBeenCalledWith(
      Events.MagnetFileSelectionSettled,
      { taskId: payload.taskId, downloadTaskId: payload.taskId }
    )
  })

  it.each([TaskStatus.Downloading, TaskStatus.Removed, undefined])(
    'discards retained magnet forms when authoritative task status becomes %s without a settle event',
    (status) => {
      const f = fixture()
      f.ready()
      f.setTaskStatus('metadata-task', TaskStatus.MetadataReady)
      f.intents.deliver('add-task', Events.MagnetFileSelection, {
        taskId: 'metadata-task',
      })
      expect(f.send).toHaveBeenCalledOnce()
      f.setTaskStatus('metadata-task', status)
      f.reload()
      f.intents.flush('add-task')
      expect(f.send).toHaveBeenCalledOnce()
      // The obsolete intent is retired, not merely hidden until the next flush.
      f.setTaskStatus('metadata-task', TaskStatus.MetadataReady)
      f.reload()
      f.intents.flush('add-task')
      expect(f.send).toHaveBeenCalledOnce()
    }
  )

  it('revalidates queued selections before the first delivery and rejects late opens for settled tasks', () => {
    const f = fixture()
    f.setTaskStatus('metadata-task', TaskStatus.MetadataReady)
    f.intents.deliver('add-task', Events.MagnetFileSelection, {
      taskId: 'metadata-task',
    })
    f.setTaskStatus('metadata-task', TaskStatus.Downloading)
    f.ready()
    f.intents.flush('add-task')
    f.intents.deliver('add-task', Events.MagnetFileSelection, {
      taskId: 'metadata-task',
    })
    expect(f.send).not.toHaveBeenCalled()
  })

  it('keeps a newer pending magnet form when an older task settles', () => {
    const f = fixture()
    f.ready()
    for (const taskId of ['first', 'second']) {
      f.setTaskStatus(taskId, TaskStatus.MetadataReady)
      f.intents.deliver('add-task', Events.MagnetFileSelection, { taskId })
    }
    const latest = f.send.mock.calls.at(-1)?.[1]
    f.intents.acknowledge('add-task', f.generation(), latest.id)
    f.intents.settleMagnetSelection('first')
    f.reload()
    f.intents.flush('add-task')
    f.intents.flush('add-task')
    expect(f.send).toHaveBeenCalledTimes(3)
    expect(f.send).toHaveBeenLastCalledWith(
      Events.RendererIntent,
      expect.objectContaining({ payload: { taskId: 'second' } })
    )
  })

  it('does not clear unrelated form drafts or queue totals when a magnet task settles', () => {
    const f = fixture()
    f.intents.deliver('add-task', Events.SetAddTaskMode, {
      url: 'https://example.com/file',
    })
    f.intents.deliver('add-task', Events.TorrentQueueSizeChanged, 2)
    f.intents.settleMagnetSelection('metadata-task')
    f.ready()
    f.intents.flush('add-task')
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.send).toHaveBeenCalledWith(
      Events.RendererIntent,
      expect.objectContaining({ payload: { url: 'https://example.com/file' } })
    )
  })

  it('waits for consumers and coalesces navigation before sending', () => {
    const f = fixture()
    for (let i = 0; i < 1_000; i++)
      f.intents.deliver('main', Events.NavigateTo, `/downloads/all?task=${i}`)
    expect(f.send).not.toHaveBeenCalled()
    f.ready()
    f.intents.flush('main')
    f.intents.flush('main')
    expect(f.send).toHaveBeenCalledExactlyOnceWith(
      Events.RendererIntent,
      expect.objectContaining({ payload: '/downloads/all?task=999' })
    )
  })
  it('rejects stale acknowledgements and replays unacknowledged navigation once per generation', () => {
    const f = fixture()
    f.ready()
    f.intents.deliver('main', Events.NavigateTo, '/settings')
    const original = f.send.mock.calls[0][1]
    f.reload()
    f.intents.flush('main')
    f.intents.acknowledge('main', original.generation, original.id)
    f.reload()
    f.intents.flush('main')
    expect(f.send).toHaveBeenCalledTimes(3)
    f.intents.acknowledge('main', f.generation(), original.id)
    f.reload()
    f.intents.flush('main')
    expect(f.send).toHaveBeenCalledTimes(3)
  })
  it('retains a live domain descriptor without copying it and clears it on dismissal', () => {
    const f = fixture()
    f.ready()
    let value = { queuePosition: 1 }
    f.intents.deliver(
      'add-task',
      Events.ProtocolTorrentFile,
      undefined,
      () => value
    )
    value = { queuePosition: 2 }
    f.reload()
    f.intents.flush('add-task')
    expect(f.send).toHaveBeenLastCalledWith(
      Events.RendererIntent,
      expect.objectContaining({ payload: { queuePosition: 2 } })
    )
    f.intents.clear('add-task')
    f.reload()
    f.intents.flush('add-task')
    expect(f.send).toHaveBeenCalledTimes(2)
  })
  it('does not retain oversized descriptors or use an undeclared event', () => {
    const f = fixture()
    f.ready()
    f.intents.deliver('add-task', Events.SetAddTaskMode, {
      url: '界'.repeat(100_000),
    })
    expect(f.intents.deliver('main', 'event:unknown', {})).toBe(false)
    expect(f.send).not.toHaveBeenCalled()
  })
})
