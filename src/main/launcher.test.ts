import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockRequestLock,
  mockHasSingleInstanceLock,
  mockExit,
  mockGetLoginItemSettings,
  mockOn,
} = vi.hoisted(() => ({
  mockRequestLock: vi.fn().mockReturnValue(true),
  mockHasSingleInstanceLock: vi.fn().mockReturnValue(true),
  mockExit: vi.fn(),
  mockGetLoginItemSettings: vi.fn().mockReturnValue({
    wasOpenedAtLogin: false,
  }),
  mockOn: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: mockRequestLock,
    hasSingleInstanceLock: mockHasSingleInstanceLock,
    exit: mockExit,
    getLoginItemSettings: mockGetLoginItemSettings,
    on: mockOn,
  },
}))

vi.mock('@core/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
  }),
}))

import { MAX_PENDING_PROTOCOL_URLS } from '@shared/schemas/app-deep-link'
import { setupLauncher } from './launcher'

describe('setupLauncher', () => {
  const callbacks = {
    onProtocolUrl: vi.fn(),
    onTorrentFile: vi.fn(),
    onShowWindow: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockOn.mockReset()
    mockRequestLock.mockReturnValue(true)
    mockHasSingleInstanceLock.mockReturnValue(true)
    mockGetLoginItemSettings.mockReturnValue({ wasOpenedAtLogin: false })
    callbacks.onProtocolUrl.mockClear()
    callbacks.onTorrentFile.mockClear()
    callbacks.onShowWindow.mockClear()
  })

  it.each(['linux', 'win32'])(
    'forwards cold and warm app links on %s, including retired mo for feedback',
    (platform) => {
      const originalPlatform = process.platform
      const originalArgv = process.argv
      Object.defineProperty(process, 'platform', { value: platform })
      process.argv = ['/opt/motrix', 'motrix://task-list']
      try {
        const handle = setupLauncher(callbacks)
        expect(callbacks.onProtocolUrl).not.toHaveBeenCalled()
        handle.flushDeferred()
        expect(callbacks.onProtocolUrl).toHaveBeenCalledExactlyOnceWith(
          'motrix://task-list'
        )
        const handler = mockOn.mock.calls.find(
          ([name]) => name === 'second-instance'
        )?.[1]
        handler({}, ['/opt/motrix', 'mo://new-task?silent=1'])
        expect(callbacks.onProtocolUrl).toHaveBeenLastCalledWith(
          'mo://new-task?silent=1'
        )
      } finally {
        process.argv = originalArgv
        Object.defineProperty(process, 'platform', { value: originalPlatform })
      }
    }
  )

  it('bounds pending URL ingress and drains each entry only once', () => {
    const handle = setupLauncher(callbacks)
    const onUrl = mockOn.mock.calls.find(([name]) => name === 'open-url')?.[1]
    for (let i = 0; i < MAX_PENDING_PROTOCOL_URLS + 10; i++) {
      onUrl({ preventDefault: vi.fn() }, 'motrix://task-list')
    }
    handle.flushDeferred()
    handle.flushDeferred()
    expect(callbacks.onProtocolUrl).toHaveBeenCalledTimes(
      MAX_PENDING_PROTOCOL_URLS
    )
  })

  it('replaces oversized links with a bounded invalid request for feedback', () => {
    const handle = setupLauncher(callbacks)
    const onUrl = mockOn.mock.calls.find(([name]) => name === 'open-url')?.[1]
    onUrl(
      { preventDefault: vi.fn() },
      `motrix://new-task?uri=${'a'.repeat(100_000)}`
    )
    handle.flushDeferred()
    expect(callbacks.onProtocolUrl).toHaveBeenCalledExactlyOnceWith(
      'motrix://invalid/#'
    )
  })

  it('acquires single instance lock', () => {
    setupLauncher(callbacks)
    expect(mockRequestLock).toHaveBeenCalled()
  })

  it('exits immediately if lock not acquired', () => {
    mockRequestLock.mockReturnValue(false)
    const handle = setupLauncher(callbacks)
    expect(mockExit).toHaveBeenCalledWith(0)
    expect(handle.bridgeDataDirLockRecoveryAuthority).toBeNull()
    expect(mockOn).not.toHaveBeenCalled()
    expect(() => handle.markWindowReady()).not.toThrow()
  })

  it('returns separate window and download ingress readiness handles', () => {
    const handle = setupLauncher(callbacks)
    expect(typeof handle.wasOpenedAtLogin).toBe('boolean')
    expect(typeof handle.markWindowReady).toBe('function')
    expect(typeof handle.flushDeferred).toBe('function')
    expect(handle.bridgeDataDirLockRecoveryAuthority).toEqual({
      ownershipEpoch: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      assertExclusiveProcessOwnership: expect.any(Function),
    })
    expect(
      handle.bridgeDataDirLockRecoveryAuthority?.assertExclusiveProcessOwnership()
    ).toBe(true)

    mockHasSingleInstanceLock.mockReturnValue(false)
    expect(
      handle.bridgeDataDirLockRecoveryAuthority?.assertExclusiveProcessOwnership()
    ).toBe(false)
  })

  it('creates a fresh recovery epoch for each successful process ownership session', () => {
    const first = setupLauncher(callbacks)
    const second = setupLauncher(callbacks)

    expect(first.bridgeDataDirLockRecoveryAuthority?.ownershipEpoch).not.toBe(
      second.bridgeDataDirLockRecoveryAuthority?.ownershipEpoch
    )
  })

  it('detects wasOpenedAtLogin on macOS', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    mockGetLoginItemSettings.mockReturnValue({ wasOpenedAtLogin: true })

    const handle = setupLauncher(callbacks)
    expect(handle.wasOpenedAtLogin).toBe(true)

    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('registers second-instance, open-url, open-file handlers', () => {
    setupLauncher(callbacks)

    const registeredEvents = mockOn.mock.calls.map((call: unknown[]) => call[0])
    expect(registeredEvents).toContain('second-instance')
    expect(registeredEvents).toContain('open-url')
    expect(registeredEvents).toContain('open-file')
  })

  describe.each(['win32', 'linux'])('%s window activation', (platform) => {
    function emitSecondInstance(argv: string[] = ['Motrix.exe']) {
      const handler = mockOn.mock.calls.find(
        ([name]) => name === 'second-instance'
      )?.[1]
      expect(handler).toBeTypeOf('function')
      handler({}, argv)
    }

    beforeEach(() => {
      const originalPlatform = process.platform
      const originalArgv = process.argv
      Object.defineProperty(process, 'platform', { value: platform })
      process.argv = ['Motrix.exe']
      return () => {
        Object.defineProperty(process, 'platform', { value: originalPlatform })
        process.argv = originalArgv
      }
    })

    it('replays early shortcut launches once after windows are ready', () => {
      const handle = setupLauncher(callbacks)
      emitSecondInstance()
      emitSecondInstance()
      expect(callbacks.onShowWindow).not.toHaveBeenCalled()

      handle.markWindowReady()
      expect(callbacks.onShowWindow).toHaveBeenCalledOnce()
      handle.markWindowReady()
      handle.flushDeferred()
      expect(callbacks.onShowWindow).toHaveBeenCalledOnce()

      emitSecondInstance()
      expect(callbacks.onShowWindow).toHaveBeenCalledTimes(2)
    })

    it('can reopen onboarding while download ingress remains deferred', () => {
      const handle = setupLauncher(callbacks)
      handle.markWindowReady()
      emitSecondInstance(['Motrix.exe', 'magnet:?xt=urn:btih:pending'])
      expect(callbacks.onShowWindow).toHaveBeenCalledOnce()
      expect(callbacks.onProtocolUrl).not.toHaveBeenCalled()

      handle.flushDeferred()
      expect(callbacks.onProtocolUrl).toHaveBeenCalledExactlyOnceWith(
        'magnet:?xt=urn:btih:pending'
      )
      expect(callbacks.onShowWindow).toHaveBeenCalledOnce()
      expect(callbacks.onShowWindow.mock.invocationCallOrder[0]).toBeLessThan(
        callbacks.onProtocolUrl.mock.invocationCallOrder[0]
      )
    })

    it('does not reveal a background launch without a second launch', () => {
      const handle = setupLauncher(callbacks)
      handle.markWindowReady()
      handle.flushDeferred()
      expect(callbacks.onShowWindow).not.toHaveBeenCalled()
    })

    it('does not discard a pending activation when download ingress flushes', () => {
      const handle = setupLauncher(callbacks)
      emitSecondInstance()
      handle.flushDeferred()
      expect(callbacks.onShowWindow).not.toHaveBeenCalled()
      handle.markWindowReady()
      expect(callbacks.onShowWindow).toHaveBeenCalledOnce()
    })
  })

  it('flushDeferred drains pending URLs', () => {
    mockOn.mockImplementation(((
      event: string,
      handler: (...args: unknown[]) => unknown
    ) => {
      if (event === 'open-url') {
        handler({ preventDefault: vi.fn() }, 'magnet:?xt=urn:btih:abc')
      }
    }) as typeof mockOn)

    const handle = setupLauncher(callbacks)
    expect(callbacks.onProtocolUrl).not.toHaveBeenCalled()

    handle.flushDeferred()
    expect(callbacks.onProtocolUrl).toHaveBeenCalledWith(
      'magnet:?xt=urn:btih:abc'
    )
  })

  it('defers a second-instance URL until startup ingress is flushed', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      const handle = setupLauncher(callbacks)
      handle.markWindowReady()
      const secondInstanceHandler = mockOn.mock.calls.find(
        (call: unknown[]) => call[0] === 'second-instance'
      )?.[1] as ((_event: unknown, argv: string[]) => void) | undefined

      secondInstanceHandler?.({}, [
        '/opt/motrix/motrix',
        'magnet:?xt=urn:btih:second-instance',
      ])

      expect(callbacks.onShowWindow).toHaveBeenCalledOnce()
      expect(callbacks.onProtocolUrl).not.toHaveBeenCalled()

      handle.flushDeferred()
      expect(callbacks.onProtocolUrl).toHaveBeenCalledOnce()
      expect(callbacks.onProtocolUrl).toHaveBeenCalledWith(
        'magnet:?xt=urn:btih:second-instance'
      )
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })

  it('defers a second-instance torrent until startup ingress is flushed', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      const handle = setupLauncher(callbacks)
      handle.markWindowReady()
      const secondInstanceHandler = mockOn.mock.calls.find(
        (call: unknown[]) => call[0] === 'second-instance'
      )?.[1] as ((_event: unknown, argv: string[]) => void) | undefined

      secondInstanceHandler?.({}, [
        '/opt/motrix/motrix',
        'file:///tmp/deferred.torrent',
      ])

      expect(callbacks.onShowWindow).toHaveBeenCalledOnce()
      expect(callbacks.onTorrentFile).not.toHaveBeenCalled()

      handle.flushDeferred()
      expect(callbacks.onTorrentFile).toHaveBeenCalledOnce()
      expect(callbacks.onTorrentFile).toHaveBeenCalledWith(
        '/tmp/deferred.torrent'
      )
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })

  it('dispatches second-instance input immediately after startup flush', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      const handle = setupLauncher(callbacks)
      handle.markWindowReady()
      handle.flushDeferred()
      const secondInstanceHandler = mockOn.mock.calls.find(
        (call: unknown[]) => call[0] === 'second-instance'
      )?.[1] as ((_event: unknown, argv: string[]) => void) | undefined

      secondInstanceHandler?.({}, [
        '/opt/motrix/motrix',
        'https://example.com/file.iso',
      ])

      expect(callbacks.onProtocolUrl).toHaveBeenCalledOnce()
      expect(callbacks.onProtocolUrl).toHaveBeenCalledWith(
        'https://example.com/file.iso'
      )
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })
})
