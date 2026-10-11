import { EventEmitter } from 'node:events'
import { Events } from '@shared/protocol/events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { RendererSupervisor } from './renderer-supervisor'

function fixture(
  mode: 'observe' | 'recover' = 'recover',
  initiallyVisible = true
) {
  let now = 0
  let visible = initiallyVisible
  const wc = Object.assign(new EventEmitter(), {
    send: vi.fn(),
    isDevToolsOpened: () => false,
  })
  const win = Object.assign(new EventEmitter(), {
    webContents: wc,
    isDestroyed: () => false,
    isVisible: () => visible,
    isMinimized: () => false,
  }) as unknown as BrowserWindow
  const deps = {
    mode,
    now: () => now,
    reload: vi.fn(),
    recreate: vi.fn(),
    report: vi.fn(),
    prompt: vi.fn(),
  }
  const supervisor = new RendererSupervisor(deps)
  supervisor.created('main', win, initiallyVisible)
  const session = () => supervisor.session(win.webContents)
  const ready = () =>
    supervisor.reportSurface(win.webContents, {
      generation: session().generation,
      surface: 'app',
      capabilities: ['navigation'],
      documentVisible: true,
    })
  const advance = (ms: number) => {
    for (let i = 0; i < ms; i += 1_000) {
      now += 1_000
      supervisor.tick()
    }
  }
  return {
    supervisor,
    deps,
    win,
    wc,
    ready,
    session,
    advance,
    jump: (ms: number) => {
      now += ms
      supervisor.tick()
    },
    hide: () => {
      visible = false
      win.emit('hide')
    },
    show: () => {
      visible = true
      win.emit('show')
    },
    crash: (reason = 'crashed') =>
      wc.emit('render-process-gone', {}, { reason, exitCode: 1 }),
  }
}

describe('RendererSupervisor', () => {
  it('waits for the mounted consumer and rejects stale generations and probes', () => {
    const f = fixture()
    f.supervisor.reportSurface(f.win.webContents, {
      generation: f.session().generation,
      surface: 'app',
      capabilities: [],
      documentVisible: true,
    })
    expect(f.supervisor.hasCapability('main', 'navigation')).toBe(false)
    f.ready()
    expect(f.supervisor.hasCapability('main', 'navigation')).toBe(true)
    const old = f.session().generation
    f.wc.emit('did-start-navigation', {}, '', false, true)
    expect(f.session().generation).not.toBe(old)
    expect(() => f.supervisor.validate(f.win.webContents, old)).toThrow('Stale')
    expect(f.supervisor.hasCapability('main', 'navigation')).toBe(false)
  })

  it('bounds crash retries across documents and never restarts a live hung renderer', () => {
    const f = fixture()
    for (const delay of [1_000, 5_000]) {
      f.ready()
      f.crash()
      f.advance(delay)
      f.wc.emit('did-start-navigation', {}, '', false, true)
    }
    expect(f.deps.reload).toHaveBeenCalledTimes(1)
    expect(f.deps.recreate).toHaveBeenCalledTimes(1)
    f.ready()
    f.crash()
    f.advance(10_000)
    expect(f.deps.prompt).toHaveBeenCalledOnce()
    expect(f.deps.report).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: 'retry-limit' })
    )
  })

  it('observes confirmed crashes without automatic reload', () => {
    const f = fixture('observe')
    f.ready()
    f.crash()
    f.advance(10_000)
    expect(f.deps.reload).not.toHaveBeenCalled()
    expect(f.deps.prompt).toHaveBeenCalledOnce()
    expect(f.supervisor.recoverManually('main')).toBe(true)
    expect(f.deps.recreate).toHaveBeenCalledWith('main', true)
    expect(f.supervisor.recoverManually('main')).toBe(false)
  })

  it('defers background crashes until explicitly shown', () => {
    const f = fixture()
    f.ready()
    f.hide()
    f.crash()
    f.advance(60_000)
    expect(f.deps.reload).not.toHaveBeenCalled()
    expect(f.deps.prompt).not.toHaveBeenCalled()
    f.show()
    f.advance(1_000)
    expect(f.deps.reload).toHaveBeenCalledOnce()
  })

  it('requires multiple missed main-world probes before prompting and accepts only the active challenge', () => {
    const f = fixture()
    f.ready()
    f.advance(15_000)
    const probe = f.wc.send.mock.calls.at(-1)?.[1]
    expect(f.wc.send).toHaveBeenLastCalledWith(
      Events.RendererHealthProbe,
      expect.any(Object)
    )
    f.supervisor.acknowledge(f.win.webContents, {
      ...probe,
      challengeId: 'wrong',
      surface: 'app',
      rootPresent: true,
      documentVisible: true,
    })
    f.advance(34_000)
    expect(f.deps.prompt).not.toHaveBeenCalled()
    f.advance(1_000)
    expect(f.deps.prompt).toHaveBeenCalledOnce()
    expect(f.deps.reload).not.toHaveBeenCalled()
  })

  it('does not count hidden time, scheduler stalls, sleep or native dialogs as failures', () => {
    const f = fixture()
    f.ready()
    f.hide()
    f.advance(120_000)
    f.show()
    f.jump(60_000)
    f.advance(29_000)
    expect(f.deps.prompt).not.toHaveBeenCalled()
    f.supervisor.setSuspended(true)
    f.advance(120_000)
    f.supervisor.setSuspended(false)
    f.advance(29_000)
    const close = f.supervisor.enterModal()
    f.advance(120_000)
    close()
    f.advance(4_000)
    expect(f.deps.prompt).not.toHaveBeenCalled()
  })

  it('handles boot failure even before ready-to-show and keeps hidden prewarm silent', () => {
    const foreground = fixture('observe', false)
    foreground.supervisor.created('main', foreground.win, true)
    foreground.advance(30_000)
    expect(foreground.deps.prompt).toHaveBeenCalledOnce()
    const background = fixture('observe', false)
    background.advance(60_000)
    expect(background.deps.prompt).not.toHaveBeenCalled()
  })

  it('keeps root fallback manual, invalidates destroyed senders and cancels shutdown work', () => {
    const f = fixture()
    f.ready()
    f.supervisor.failure(f.win.webContents, {
      generation: f.session().generation,
      scope: 'root',
      errorCode: 'render-failed',
    })
    f.advance(60_000)
    expect(f.deps.prompt).not.toHaveBeenCalled()
    expect(f.deps.reload).not.toHaveBeenCalled()
    f.supervisor.dispose()
    expect(() => f.session()).toThrow('Unknown')
    f.crash()
    f.advance(60_000)
    expect(f.deps.reload).not.toHaveBeenCalled()
    expect(f.wc.listenerCount('render-process-gone')).toBe(0)
  })
  it('does not apply an old native dialog response to a replacement document', () => {
    const f = fixture('observe')
    f.ready()
    f.crash()
    const incident = f.deps.prompt.mock.calls[0][0]
    expect(f.supervisor.isCurrentIncident(incident)).toBe(true)
    f.wc.emit('did-start-navigation', {}, '', false, true)
    f.supervisor.loadFailed('main', f.win)
    expect(f.supervisor.isCurrentIncident(incident)).toBe(false)
  })
})
