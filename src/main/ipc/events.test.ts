import { EventBus } from '@core/events/event-bus'
import { Events } from '@shared/protocol/events'
import { describe, expect, it, vi } from 'vitest'
import type { WindowManager } from '../window/window-manager'
import { setupEventForwarding } from './events'

function createFakeWindow(isDestroyed = false, isLoading = false) {
  return {
    isDestroyed: vi.fn(() => isDestroyed),
    webContents: {
      send: vi.fn(),
      isLoading: vi.fn(() => isLoading),
      once: vi.fn(),
    },
  }
}

function createWindowManager(
  mainWin: ReturnType<typeof createFakeWindow> | null = null,
  addTaskWin: ReturnType<typeof createFakeWindow> | null = null
): WindowManager {
  return {
    get: vi.fn((id: string) => {
      if (id === 'main') return mainWin
      if (id === 'add-task') return addTaskWin
      return null
    }),
    broadcast: vi.fn(),
    open: vi.fn(),
    show: vi.fn(),
    close: vi.fn(),
    getAllWindows: vi.fn(() => []),
    getWindowIdBySender: vi.fn(),
    precreate: vi.fn(),
  } as unknown as WindowManager
}

describe('setupEventForwarding', () => {
  it('broadcasts locale changes to every managed window', () => {
    const eventBus = new EventBus()
    const wm = createWindowManager()

    setupEventForwarding(eventBus, wm)
    eventBus.emit(Events.LocaleChanged, { language: 'zh-CN' })

    expect(wm.broadcast).toHaveBeenCalledWith(Events.LocaleChanged, {
      language: 'zh-CN',
    })
  })

  describe('NavigateTo', () => {
    it('shows main and forwards NavigateTo when its renderer is loaded', () => {
      vi.useFakeTimers()
      const eventBus = new EventBus()
      const mainWin = createFakeWindow(false, false)
      const wm = createWindowManager(mainWin)

      setupEventForwarding(eventBus, wm)
      eventBus.emit(
        Events.NavigateTo as Parameters<typeof eventBus.emit>[0],
        '/settings'
      )

      expect(wm.show).toHaveBeenCalledWith('main')
      vi.advanceTimersByTime(100)
      expect(mainWin.webContents.send).toHaveBeenCalledExactlyOnceWith(
        Events.NavigateTo,
        '/settings'
      )
      vi.useRealTimers()
    })

    it('shows main but tolerates a legal gate that leaves it unavailable', () => {
      const eventBus = new EventBus()
      const wm = createWindowManager(null)

      setupEventForwarding(eventBus, wm)

      expect(() => {
        eventBus.emit(
          Events.NavigateTo as Parameters<typeof eventBus.emit>[0],
          '/settings'
        )
      }).not.toThrow()
      expect(wm.show).toHaveBeenCalledWith('main')
    })

    it('does not send NavigateTo when main window is destroyed', () => {
      const eventBus = new EventBus()
      const mainWin = createFakeWindow(true)
      const wm = createWindowManager(mainWin)

      setupEventForwarding(eventBus, wm)
      eventBus.emit(
        Events.NavigateTo as Parameters<typeof eventBus.emit>[0],
        '/settings'
      )

      expect(wm.show).toHaveBeenCalledWith('main')
      expect(mainWin.webContents.send).not.toHaveBeenCalled()
    })

    it('waits for a newly-created main renderer before navigation', () => {
      vi.useFakeTimers()
      const eventBus = new EventBus()
      const mainWin = createFakeWindow(false, true)
      const wm = createWindowManager(mainWin)

      setupEventForwarding(eventBus, wm)
      eventBus.emit(
        Events.NavigateTo as Parameters<typeof eventBus.emit>[0],
        '/downloads'
      )

      expect(mainWin.webContents.send).not.toHaveBeenCalled()
      const didFinishLoad = mainWin.webContents.once.mock.calls.find(
        ([event]) => event === 'did-finish-load'
      )?.[1] as (() => void) | undefined
      expect(didFinishLoad).toBeInstanceOf(Function)

      didFinishLoad?.()
      vi.advanceTimersByTime(100)
      expect(mainWin.webContents.send).toHaveBeenCalledExactlyOnceWith(
        Events.NavigateTo,
        '/downloads'
      )
      vi.useRealTimers()
    })
  })

  describe('MagnetFileSelection (regression)', () => {
    it('shows add-task window and sends magnet selection when already loaded', () => {
      vi.useFakeTimers()
      const eventBus = new EventBus()
      const addTaskWin = createFakeWindow(false, false)
      const wm = createWindowManager(null, addTaskWin)

      setupEventForwarding(eventBus, wm)
      eventBus.emit(
        Events.MagnetFileSelection as Parameters<typeof eventBus.emit>[0],
        { magnetUri: 'magnet:?xt=urn:btih:abc123' }
      )

      expect(wm.show).toHaveBeenCalledWith('add-task')
      vi.advanceTimersByTime(100)
      expect(addTaskWin.webContents.send).toHaveBeenCalledWith(
        Events.MagnetFileSelection,
        { magnetUri: 'magnet:?xt=urn:btih:abc123' }
      )

      vi.useRealTimers()
    })

    it('waits for add-task did-finish-load before sending magnet selection', () => {
      vi.useFakeTimers()
      const eventBus = new EventBus()
      const addTaskWin = createFakeWindow(false, true)
      const wm = createWindowManager(null, addTaskWin)

      setupEventForwarding(eventBus, wm)
      eventBus.emit(
        Events.MagnetFileSelection as Parameters<typeof eventBus.emit>[0],
        { magnetUri: 'magnet:?xt=urn:btih:abc123' }
      )

      expect(wm.show).toHaveBeenCalledWith('add-task')
      expect(addTaskWin.webContents.send).not.toHaveBeenCalled()

      const didFinishLoad = addTaskWin.webContents.once.mock.calls.find(
        ([event]) => event === 'did-finish-load'
      )?.[1] as (() => void) | undefined
      expect(didFinishLoad).toBeInstanceOf(Function)

      didFinishLoad?.()
      vi.advanceTimersByTime(100)

      expect(addTaskWin.webContents.send).toHaveBeenCalledWith(
        Events.MagnetFileSelection,
        { magnetUri: 'magnet:?xt=urn:btih:abc123' }
      )

      vi.useRealTimers()
    })
  })
})
