import windowsPackageConfig from '@shared/config/windows-package.json'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWindowsPackageActivation } from './windows-package-activation'

function setup(isWindowsPackage = true) {
  let activate: (details: unknown) => void = () => {}
  const order: string[] = []
  const deps = {
    isWindowsPackage,
    setToastActivatorCLSID: vi.fn(() => order.push('clsid')),
    handleActivation: vi.fn((callback: (details: unknown) => void) => {
      order.push('callback')
      activate = callback
    }),
    isSupported: vi.fn(() => {
      order.push('presenter')
      return true
    }),
    openMainWindow: vi.fn(),
    log: { warn: vi.fn() },
  }
  const controller = createWindowsPackageActivation(deps)
  return {
    controller,
    deps,
    order,
    activate: (value: unknown) => activate(value),
  }
}

describe('Windows package notification activation', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sets the manifest CLSID before registering callbacks or initializing COM', () => {
    const { controller, deps, order } = setup()
    expect(deps.setToastActivatorCLSID).toHaveBeenCalledWith(
      windowsPackageConfig.toastActivatorClsid
    )
    expect(order).toEqual(['clsid', 'callback'])
    controller.initializePresenter()
    controller.initializePresenter()
    expect(order).toEqual(['clsid', 'callback', 'presenter'])
  })

  it('leaves non-package notification behavior untouched', () => {
    const { controller, deps, activate } = setup(false)
    controller.initializePresenter()
    controller.flush()
    controller.handleLiveClick()
    controller.claimLiveClick()
    activate({ type: 'click', arguments: '' })
    vi.runAllTimers()
    expect(deps.setToastActivatorCLSID).not.toHaveBeenCalled()
    expect(deps.handleActivation).not.toHaveBeenCalled()
    expect(deps.isSupported).not.toHaveBeenCalled()
    expect(deps.openMainWindow).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('buffers cold-start clicks without accessing uninitialized window state', () => {
    const { controller, deps, activate } = setup()
    for (let i = 0; i < 1000; i++) activate({ type: 'click', arguments: '' })
    expect(vi.getTimerCount()).toBe(0)
    vi.runAllTimers()
    expect(deps.openMainWindow).not.toHaveBeenCalled()
    controller.initializePresenter()
    expect(deps.openMainWindow).not.toHaveBeenCalled()
    controller.flush()
    controller.flush()
    expect(vi.getTimerCount()).toBe(1)
    vi.runAllTimers()
    expect(deps.openMainWindow).toHaveBeenCalledOnce()
  })

  it('also buffers an activation delivered synchronously during registration', () => {
    const openMainWindow = vi.fn()
    const controller = createWindowsPackageActivation({
      isWindowsPackage: true,
      setToastActivatorCLSID: vi.fn(),
      handleActivation: (callback) =>
        callback({ type: 'click', arguments: '' }),
      isSupported: () => true,
      openMainWindow,
      log: { warn: vi.fn() },
    })
    expect(openMainWindow).not.toHaveBeenCalled()
    controller.flush()
    vi.runAllTimers()
    expect(openMainWindow).toHaveBeenCalledOnce()
  })

  it.each([
    'motrix://add?url=https://example.com/file',
    'C:\\private\\secret.torrent',
    'type=action&action=0&tag=untrusted-task',
  ])('never forwards body activation arguments: %s', (argumentsValue) => {
    const { controller, deps, activate } = setup()
    controller.flush()
    activate({ type: 'click', arguments: argumentsValue })
    vi.runAllTimers()
    expect(deps.openMainWindow).toHaveBeenCalledExactlyOnceWith()
  })

  it.each([
    null,
    {},
    { type: 'action', actionIndex: 0, arguments: '' },
    { type: 'reply', reply: 'hello', arguments: '' },
    { type: 'click' },
    { type: 'click', arguments: 1 },
    { type: 'click', arguments: 'x'.repeat(4097) },
  ])('ignores unsupported or malformed activation %j', (details) => {
    const { controller, deps, activate } = setup()
    controller.flush()
    activate(details)
    vi.runAllTimers()
    expect(deps.openMainWindow).not.toHaveBeenCalled()
  })

  it('lets a live task click cancel the preceding COM fallback in the same turn', () => {
    const { controller, deps, activate } = setup()
    controller.flush()
    activate({ type: 'click', arguments: '' })
    controller.claimLiveClick()
    vi.runAllTimers()
    expect(deps.openMainWindow).not.toHaveBeenCalled()
    // A later, independent persisted click must still work.
    activate({ type: 'click', arguments: '' })
    vi.runAllTimers()
    expect(deps.openMainWindow).toHaveBeenCalledOnce()
  })

  it('also suppresses a fallback arriving after a live claim in the same turn', () => {
    const { controller, deps, activate } = setup()
    controller.flush()
    controller.claimLiveClick()
    activate({ type: 'click', arguments: '' })
    vi.runAllTimers()
    expect(deps.openMainWindow).not.toHaveBeenCalled()
  })

  it('coalesces plugin and global clicks into one safe open', () => {
    const { controller, deps, activate } = setup()
    controller.flush()
    activate({ type: 'click', arguments: '' })
    controller.handleLiveClick()
    controller.handleLiveClick()
    vi.runAllTimers()
    expect(deps.openMainWindow).toHaveBeenCalledOnce()
  })

  it('discards startup clicks and ignores all entry points after shutdown', () => {
    const { controller, deps, activate } = setup()
    activate({ type: 'click', arguments: '' })
    controller.dispose()
    controller.initializePresenter()
    controller.flush()
    controller.handleLiveClick()
    controller.claimLiveClick()
    activate({ type: 'click', arguments: '' })
    vi.runAllTimers()
    expect(deps.isSupported).not.toHaveBeenCalled()
    expect(deps.openMainWindow).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels an already scheduled fallback during shutdown', () => {
    const { controller, deps } = setup()
    controller.flush()
    controller.handleLiveClick()
    expect(vi.getTimerCount()).toBe(1)
    controller.dispose()
    expect(vi.getTimerCount()).toBe(0)
    vi.runAllTimers()
    expect(deps.openMainWindow).not.toHaveBeenCalled()
  })

  it('reports an unavailable presenter without blocking shell readiness', () => {
    const { controller, deps } = setup()
    deps.isSupported.mockReturnValue(false)
    expect(() => controller.initializePresenter()).not.toThrow()
    expect(deps.log.warn).toHaveBeenCalledWith(
      'windows-package notifications are unavailable'
    )
    controller.flush()
    controller.handleLiveClick()
    vi.runAllTimers()
    expect(deps.openMainWindow).toHaveBeenCalledOnce()
  })

  it('contains presenter initialization errors and logs a fixed message', () => {
    const { controller, deps } = setup()
    const err = new Error('COM failed')
    deps.isSupported.mockImplementation(() => {
      throw err
    })
    expect(() => controller.initializePresenter()).not.toThrow()
    expect(deps.log.warn).toHaveBeenCalledWith(
      { err },
      'windows-package notification presenter initialization failed'
    )
  })

  it('contains shell navigation failures without leaking the OS arguments', () => {
    const { controller, deps, activate } = setup()
    const err = new Error('window unavailable')
    deps.openMainWindow.mockImplementation(() => {
      throw err
    })
    controller.flush()
    activate({ type: 'click', arguments: 'private/path' })
    expect(() => vi.runAllTimers()).not.toThrow()
    expect(deps.log.warn).toHaveBeenCalledWith(
      { err },
      'windows-package notification activation failed'
    )
  })
})
