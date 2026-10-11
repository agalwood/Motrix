import { randomUUID } from 'node:crypto'
import { Events } from '@shared/protocol/events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { RendererIntents } from './renderer-intents'

function fixture() {
  let ready = false
  let generation = randomUUID()
  const send = vi.fn()
  const win = {
    isDestroyed: () => false,
    webContents: { send },
  } as unknown as BrowserWindow
  const intents = new RendererIntents({
    window: () => win,
    session: () => ({ generation }),
    ready: () => ready,
  })
  return {
    intents,
    send,
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
