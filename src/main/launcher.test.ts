import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRequestLock, mockExit, mockGetLoginItemSettings, mockOn } =
  vi.hoisted(() => ({
    mockRequestLock: vi.fn().mockReturnValue(true),
    mockExit: vi.fn(),
    mockGetLoginItemSettings: vi.fn().mockReturnValue({
      wasOpenedAtLogin: false,
    }),
    mockOn: vi.fn(),
  }))

vi.mock('electron', () => ({
  app: {
    requestSingleInstanceLock: mockRequestLock,
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
    callbacks.onProtocolUrl.mockClear()
    callbacks.onTorrentFile.mockClear()
    callbacks.onShowWindow.mockClear()
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
  })

  it('returns handle with wasOpenedAtLogin and flushDeferred', () => {
    const handle = setupLauncher(callbacks)
    expect(typeof handle.wasOpenedAtLogin).toBe('boolean')
    expect(typeof handle.flushDeferred).toBe('function')
    expect(handle.bridgeDataDirLockRecoveryAuthority).toEqual({
      ownershipEpoch: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      assertExclusiveProcessOwnership: expect.any(Function),
    })
    expect(
      handle.bridgeDataDirLockRecoveryAuthority?.assertExclusiveProcessOwnership()
    ).toBe(true)
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
