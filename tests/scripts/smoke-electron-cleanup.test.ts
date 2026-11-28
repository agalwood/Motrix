// @vitest-environment node

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stopPackagedApp } from '../../scripts/smoke-electron-package.mjs'
import { MenuItemIds } from '../../src/main/menu/menu-ids'
import { Commands } from '../../src/shared/protocol/commands'
import { Queries } from '../../src/shared/protocol/queries'

class OwnedChild extends EventEmitter {
  pid = 4321
  exitCode: number | null = null
  signalCode: string | null = null
  kill = vi.fn()

  exit(code: number | null, signal: string | null = null) {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('packaged Electron shutdown', () => {
  it('requests the current menu quit action before waiting for Windows exit', async () => {
    vi.useFakeTimers()
    const child = new OwnedChild()
    const execFile = vi.fn()
    const invoke = vi.fn(async (channel) => {
      expect(child.listenerCount('exit')).toBe(1)
      if (channel === Queries.GetApplicationMenu) return { revision: 7 }
      child.exit(0)
      throw new Error('Execution context was destroyed')
    })
    vi.stubGlobal('window', { motrix: { invoke } })
    const page = {
      evaluate: vi.fn(async (action, channels) => action(channels)),
    }

    await expect(
      stopPackagedApp(child, page, { platform: 'win32', execFile })
    ).resolves.toBeUndefined()
    expect(invoke.mock.calls).toEqual([
      [Queries.GetApplicationMenu],
      [
        Commands.ExecuteApplicationMenuItem,
        {
          itemId: MenuItemIds.AppQuit,
          revision: 7,
          trigger: 'menu',
          selectedTaskId: null,
        },
      ],
    ])
    expect(execFile).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['darwin', 'linux'])(
    'retains graceful SIGTERM handling on %s',
    async (platform) => {
      vi.useFakeTimers()
      const child = new OwnedChild()
      const page = { evaluate: vi.fn() }
      const execFile = vi.fn()
      child.kill.mockImplementation((signal) => {
        expect(child.listenerCount('exit')).toBe(1)
        expect(signal).toBe('SIGTERM')
        child.exit(0)
      })
      await expect(
        stopPackagedApp(child, page, { platform, execFile })
      ).resolves.toBeUndefined()
      expect(child.kill).toHaveBeenCalledOnce()
      expect(page.evaluate).not.toHaveBeenCalled()
      expect(execFile).not.toHaveBeenCalled()
      expect(child.listenerCount('exit')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it('bounds a hung IPC and kills only the owned Windows process tree without passing', async () => {
    vi.useFakeTimers()
    const child = new OwnedChild()
    const execFile = vi.fn(async () => {
      child.exit(1)
    })
    const page = { evaluate: vi.fn(() => new Promise(() => {})) }
    const stopped = stopPackagedApp(child, page, {
      platform: 'win32',
      timeoutMs: 100,
      forceTimeoutMs: 50,
      execFile,
    })
    const failed = expect(stopped).rejects.toThrow(
      'graceful shutdown timed out after 100ms'
    )
    await vi.advanceTimersByTimeAsync(99)
    expect(execFile).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await failed
    expect(execFile).toHaveBeenCalledWith(
      'taskkill.exe',
      ['/PID', '4321', '/T', '/F'],
      { windowsHide: true, timeout: 50 }
    )
    expect(child.kill).not.toHaveBeenCalled()
    expect(child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps IPC failure diagnostic and bounds fallback cleanup that never finishes', async () => {
    vi.useFakeTimers()
    const child = new OwnedChild()
    const page = {
      evaluate: vi.fn(async () => {
        throw new Error('menu unavailable')
      }),
    }
    const execFile = vi.fn(() => new Promise(() => {}))
    const stopped = stopPackagedApp(child, page, {
      platform: 'win32',
      timeoutMs: 100,
      forceTimeoutMs: 50,
      execFile,
    })
    const failed = expect(stopped).rejects.toThrow(
      /shutdown and cleanup failed:.*menu unavailable; app cleanup timed out after 50ms/
    )
    await vi.advanceTimersByTimeAsync(150)
    await failed
    expect(execFile).toHaveBeenCalledOnce()
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.listenerCount('error')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cleans up a startup failure with no page without waiting for an IPC deadline', async () => {
    vi.useFakeTimers()
    const child = new OwnedChild()
    const execFile = vi.fn(async () => {
      child.exit(1)
    })
    await expect(
      stopPackagedApp(child, undefined, {
        platform: 'win32',
        execFile,
      })
    ).rejects.toThrow('main renderer is unavailable')
    expect(execFile).toHaveBeenCalledOnce()
    expect(child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a nonzero app exit and never taskkills an already exited PID', async () => {
    const child = new OwnedChild()
    const execFile = vi.fn()
    const page = {
      evaluate: vi.fn(async () => {
        child.exit(2)
      }),
    }
    await expect(
      stopPackagedApp(child, page, {
        platform: 'win32',
        execFile,
      })
    ).rejects.toThrow('code=2')
    expect(execFile).not.toHaveBeenCalled()
    expect(child.listenerCount('exit')).toBe(0)
  })

  it('uses a bounded Unix fallback only after graceful shutdown fails', async () => {
    vi.useFakeTimers()
    const child = new OwnedChild()
    child.kill.mockImplementation((signal) => {
      if (signal === 'SIGKILL') child.exit(null, 'SIGKILL')
    })
    const page = { evaluate: vi.fn(() => new Promise(() => {})) }
    const stopped = stopPackagedApp(child, page, {
      platform: 'linux',
      timeoutMs: 100,
    })
    const failed = expect(stopped).rejects.toThrow(
      'graceful shutdown timed out'
    )
    await vi.advanceTimersByTimeAsync(100)
    await failed
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
    expect(vi.getTimerCount()).toBe(0)
  })
})
