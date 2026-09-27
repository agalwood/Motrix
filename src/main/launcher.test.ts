import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { setupLauncher } from './launcher'

describe('setupLauncher', () => {
  const originalPlatform = process.platform
  const originalArgv = process.argv
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
    callbacks.onProtocolUrl.mockClear()
    callbacks.onTorrentFile.mockClear()
    callbacks.onShowWindow.mockClear()
    process.argv = ['motrix']
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    process.argv = originalArgv
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

  function eventHandler(event: string): (...args: unknown[]) => void {
    const handler = mockOn.mock.calls.find(([name]) => name === event)?.[1]
    expect(handler).toBeTypeOf('function')
    return handler
  }

  it('defers the package launch URI and forwards subsequent activations', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.argv = ['motrix', 'motrix-store://open']
    const handle = setupLauncher(callbacks)
    expect(callbacks.onProtocolUrl).not.toHaveBeenCalled()
    handle.flushDeferred()
    eventHandler('second-instance')({}, ['motrix', 'MOTRIX-STORE://OPEN/'])
    expect(callbacks.onProtocolUrl.mock.calls).toEqual([
      ['motrix-store://open'],
      ['MOTRIX-STORE://OPEN/'],
    ])
    expect(callbacks.onTorrentFile).not.toHaveBeenCalled()
  })

  it('routes malformed package URLs to protocol validation, never file ingestion', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const url = 'motrix-store://open?uri=https://example.com/file.torrent'
    process.argv = ['motrix', url]
    const handle = setupLauncher(callbacks)
    handle.flushDeferred()
    eventHandler('second-instance')({}, ['motrix', url])
    expect(callbacks.onProtocolUrl.mock.calls).toEqual([[url], [url]])
    expect(callbacks.onTorrentFile).not.toHaveBeenCalled()
  })

  describe.each(['motrix', 'mo'])('%s deeplinks', (scheme) => {
    it.each(['win32', 'linux'])(
      'defers a cold-start URL on %s and never treats it as a torrent file',
      (platform) => {
        Object.defineProperty(process, 'platform', { value: platform })
        const url = `${scheme.toUpperCase()}://new-task?uri=https%3A%2F%2Fexample.com%2FFile.torrent`
        process.argv = ['motrix', '--opened-at-login=1', url]

        const handle = setupLauncher(callbacks)
        expect(handle.wasOpenedAtLogin).toBe(true)
        expect(callbacks.onProtocolUrl).not.toHaveBeenCalled()
        expect(callbacks.onTorrentFile).not.toHaveBeenCalled()

        handle.flushDeferred()
        handle.flushDeferred()
        expect(callbacks.onProtocolUrl).toHaveBeenCalledExactlyOnceWith(url)
        expect(callbacks.onTorrentFile).not.toHaveBeenCalled()
      }
    )

    it.each(['win32', 'linux'])(
      'preserves second-instance URLs before and after flush on %s',
      (platform) => {
        Object.defineProperty(process, 'platform', { value: platform })
        const handle = setupLauncher(callbacks)
        const first = `${scheme}://tasks/${encodeURIComponent('任务/一?#&%')}`
        const second = `${scheme}://plugins/example.archive-unpacker`
        const onSecondInstance = eventHandler('second-instance')

        onSecondInstance({}, ['motrix', first])
        expect(callbacks.onProtocolUrl).not.toHaveBeenCalled()
        expect(callbacks.onShowWindow).toHaveBeenCalledOnce()

        handle.flushDeferred()
        expect(callbacks.onProtocolUrl).toHaveBeenCalledExactlyOnceWith(first)
        onSecondInstance({}, ['motrix', second])
        expect(callbacks.onProtocolUrl.mock.calls).toEqual([[first], [second]])
        expect(callbacks.onShowWindow).toHaveBeenCalledTimes(2)
        expect(callbacks.onTorrentFile).not.toHaveBeenCalled()
      }
    )

    it('uses open-url on macOS before and after flush without reading argv', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      process.argv = ['motrix', `${scheme}://tasks/ignored-argv`]
      const handle = setupLauncher(callbacks)
      const first = `${scheme}://tasks/task-1`
      const second = `${scheme.toUpperCase()}://new-task?uri=magnet%3A%3Fxt%3Durn%3Abtih%3Aabc`
      const event = { preventDefault: vi.fn() }
      const onOpenUrl = eventHandler('open-url')

      onOpenUrl(event, first)
      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(callbacks.onProtocolUrl).not.toHaveBeenCalled()
      handle.flushDeferred()
      expect(callbacks.onProtocolUrl).toHaveBeenCalledExactlyOnceWith(first)

      onOpenUrl(event, second)
      expect(event.preventDefault).toHaveBeenCalledTimes(2)
      expect(callbacks.onProtocolUrl.mock.calls).toEqual([[first], [second]])
      expect(callbacks.onTorrentFile).not.toHaveBeenCalled()
    })
  })

  it.each([
    'http://example.com/file.torrent',
    'HTTPS://example.com/File.TORRENT',
    'ftp://example.com/file.torrent',
    'magnet:?xt=urn:btih:abc&dn=file.torrent',
  ])('does not also dispatch resource URL %s as a torrent file', (url) => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    process.argv = ['motrix', url, 'C:\\Downloads\\local.torrent']
    const handle = setupLauncher(callbacks)
    handle.flushDeferred()
    expect(callbacks.onProtocolUrl).toHaveBeenCalledExactlyOnceWith(url)
    expect(callbacks.onTorrentFile).toHaveBeenCalledExactlyOnceWith(
      'C:\\Downloads\\local.torrent'
    )
  })

  it('ignores switches and lookalike schemes while preserving the first URL', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const url = 'mo://tasks/first'
    process.argv = [
      'motrix',
      '--url=motrix://tasks/ignored',
      'motrix+other://tasks/ignored',
      'mo+other://tasks/ignored',
      url,
      'motrix://tasks/second',
    ]
    const handle = setupLauncher(callbacks)
    handle.flushDeferred()
    expect(callbacks.onProtocolUrl).toHaveBeenCalledExactlyOnceWith(url)
    expect(callbacks.onTorrentFile).not.toHaveBeenCalled()
  })
})
