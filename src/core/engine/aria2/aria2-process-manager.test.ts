import { AppError, ErrorCode } from '@shared/errors'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock child_process ──────────────────────────────────────
// vi.mock is hoisted to top of file, so variables used inside the
// factory must be declared with vi.hoisted() to avoid TDZ errors.

const { mockExecFile, mockSpawnFn, mockLogError, mockLogInfo } = vi.hoisted(
  () => ({
    mockExecFile: vi.fn(),
    mockSpawnFn: vi.fn(),
    mockLogError: vi.fn(),
    mockLogInfo: vi.fn(),
  })
)

vi.mock('node:child_process', () => {
  return {
    execFile: mockExecFile,
    spawn: mockSpawnFn,
    default: { execFile: mockExecFile, spawn: mockSpawnFn },
  }
})

vi.mock('@core/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    error: mockLogError,
    info: mockLogInfo,
    warn: vi.fn(),
  }),
}))

// Import after mocking
import { Aria2ProcessManager } from './aria2-process-manager'

// ─── Helpers ─────────────────────────────────────────────────

function createMockChildProcess() {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {}
  return {
    pid: 12345,
    killed: false,
    listeners,
    on(event: string, handler: (...args: unknown[]) => void) {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(handler)
      return this
    },
    kill(signal?: string) {
      this.killed = true
      // Simulate exit after kill
      const exitHandlers = listeners.exit ?? []
      for (const h of exitHandlers) {
        h(null, signal ?? 'SIGKILL')
      }
    },
    stdout: {
      on: vi.fn(),
    },
    stderr: {
      on: vi.fn(),
    },
    _emit(event: string, ...args: unknown[]) {
      for (const h of listeners[event] ?? []) {
        h(...args)
      }
    },
  }
}

// ─── Standard aria2 --version output ─────────────────────────

const ARIA2_VERSION_OUTPUT = `aria2 version 1.37.0-motrix.10
Copyright (C) 2006, 2019 Tatsuhiro Tsujikawa

This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or
(at your option) any later version.

  Homepage: https://aria2.github.io/
  License: GPLv2

Libraries:
  ...

Enabled Features: Async DNS, BitTorrent, Firefox3 Cookie, GZip, HTTPS, Message Digest, Metalink, XML-RPC, SFTP, SQLite3-Persistence
`

const ARIA2_NO_SQLITE_OUTPUT = `aria2 version 1.36.0
Copyright (C) 2006, 2019 Tatsuhiro Tsujikawa

Enabled Features: Async DNS, BitTorrent, Firefox3 Cookie, GZip, HTTPS, Message Digest, Metalink, XML-RPC
`

describe('Aria2ProcessManager', () => {
  let manager: Aria2ProcessManager

  beforeEach(() => {
    manager = new Aria2ProcessManager()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('probe', () => {
    it('parses version and features from aria2 --version output', async () => {
      mockExecFile.mockImplementation(
        (
          _path: string,
          _args: string[],
          callback: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          callback(null, ARIA2_VERSION_OUTPUT, '')
        }
      )

      const report = await manager.probe('/usr/bin/aria2c')

      expect(mockExecFile).toHaveBeenCalledWith(
        '/usr/bin/aria2c',
        ['--version'],
        expect.any(Function)
      )
      expect(report.version).toBe('1.37.0-motrix.10')
      expect(report.features).toContain('BitTorrent')
      expect(report.features).toContain('SQLite3-Persistence')
      expect(report.hasSqlitePersistence).toBe(true)
      // The probe-time report is the one EngineSupervisor stores and both
      // shells serve, so its version-derived BT flags must be real (1.37.0 ≥
      // 1.37.0), not hardcoded false.
      expect(report.hasBtSeedUnverified).toBe(true)
      expect(report.hasBtSaveMetadata).toBe(true)
    })

    it('detects when SQLite3-Persistence is absent', async () => {
      mockExecFile.mockImplementation(
        (
          _path: string,
          _args: string[],
          callback: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          callback(null, ARIA2_NO_SQLITE_OUTPUT, '')
        }
      )

      const report = await manager.probe('/usr/bin/aria2c')

      expect(report.version).toBe('1.36.0')
      expect(report.hasSqlitePersistence).toBe(false)
    })

    it('throws AppError when binary does not exist', async () => {
      mockExecFile.mockImplementation(
        (
          _path: string,
          _args: string[],
          callback: (err: Error | null) => void
        ) => {
          const err = new Error('ENOENT: no such file')
          callback(err)
        }
      )

      await expect(manager.probe('/nonexistent/aria2c')).rejects.toThrow(
        AppError
      )

      try {
        await manager.probe('/nonexistent/aria2c')
      } catch (err) {
        expect(err).toBeInstanceOf(AppError)
        expect((err as AppError).code).toBe(ErrorCode.EngineStartFailed)
      }
    })

    it('throws AppError when output cannot be parsed', async () => {
      mockExecFile.mockImplementation(
        (
          _path: string,
          _args: string[],
          callback: (err: Error | null, stdout: string, stderr: string) => void
        ) => {
          callback(null, 'not aria2 output', '')
        }
      )

      await expect(manager.probe('/usr/bin/something-else')).rejects.toThrow(
        AppError
      )
    })

    describe('parses fork feature tag', () => {
      it('detects SQLite3-Persistence in enabledFeatures', async () => {
        mockExecFile.mockImplementation(
          (
            _bin: string,
            args: string[],
            cb: (err: Error | null, stdout: string, stderr: string) => void
          ) => {
            expect(args).toEqual(['--version'])
            cb(
              null,
              'aria2 version 1.37.0\n' +
                'Enabled Features: Async DNS, BitTorrent, Metalink, SQLite3-Persistence\n',
              ''
            )
          }
        )
        const report = await manager.probe('/path/to/aria2c')
        expect(report.features).toContain('SQLite3-Persistence')
        expect(report.hasSqlitePersistence).toBe(true)
      })

      it('returns hasSqlitePersistence=false when tag absent', async () => {
        mockExecFile.mockImplementation(
          (
            _bin: string,
            _args: string[],
            cb: (err: Error | null, stdout: string, stderr: string) => void
          ) => {
            cb(
              null,
              'aria2 version 1.37.0\nEnabled Features: Async DNS, BitTorrent\n',
              ''
            )
          }
        )
        const report = await manager.probe('/path/to/aria2c')
        expect(report.hasSqlitePersistence).toBe(false)
      })

      it('runs only --version, not --help', async () => {
        const calls: string[][] = []
        mockExecFile.mockImplementation(
          (
            _bin: string,
            args: string[],
            cb: (err: Error | null, stdout: string, stderr: string) => void
          ) => {
            calls.push(args)
            cb(
              null,
              'aria2 version 1.37.0\nEnabled Features: SQLite3-Persistence\n',
              ''
            )
          }
        )
        await manager.probe('/path/to/aria2c')
        expect(calls).toEqual([['--version']])
      })
    })
  })

  describe('spawn', () => {
    it('spawns child process with correct args', async () => {
      const mockChild = createMockChildProcess()
      mockSpawnFn.mockReturnValue(mockChild)

      const args = [
        '--rpc-listen-port=16800',
        '--rpc-secret=test',
        '--all-proxy=http://local-user:local-password@127.0.0.1:43123',
        '--all-proxy-user=local-user',
        '--all-proxy-passwd=local-password',
      ]
      const spawnPromise = manager.spawn('/usr/bin/aria2c', args)

      // Simulate process ready (emitting no immediate error
      // means it's running). Resolve the promise by allowing
      // the microtask to settle. In real code, spawn resolves
      // immediately once the child process is created without error.

      await spawnPromise

      expect(mockSpawnFn).toHaveBeenCalledWith('/usr/bin/aria2c', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      expect(mockLogInfo).toHaveBeenCalledWith(
        {
          pid: 12345,
          args: [
            '--rpc-listen-port=16800',
            '--rpc-secret=<redacted>',
            '--all-proxy=<redacted>',
            '--all-proxy-user=<redacted>',
            '--all-proxy-passwd=<redacted>',
          ],
        },
        'aria2 process spawned'
      )
      expect(manager.isRunning()).toBe(true)
      expect(manager.getPid()).toBe(12345)
    })

    it('passes a dedicated environment to the aria2 child', async () => {
      const mockChild = createMockChildProcess()
      mockSpawnFn.mockReturnValue(mockChild)
      const env = {
        PATH: '/usr/bin',
        SSL_CERT_FILE: '/tmp/aria2-ca-bundle.pem',
      }

      await manager.spawn('/usr/bin/aria2c', [], env)

      expect(mockSpawnFn).toHaveBeenCalledWith('/usr/bin/aria2c', [], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      })
    })

    it('promotes sparse native RPC diagnostics into production logs', async () => {
      const mockChild = createMockChildProcess()
      mockSpawnFn.mockReturnValue(mockChild)

      await manager.spawn('/usr/bin/aria2c', ['--rpc-secret=secret-value'])

      const stdoutHandler = mockChild.stdout.on.mock.calls[0]?.[1]
      stdoutHandler?.(
        Buffer.from(
          'RPC-DIAG CUID#7 first WebSocket response queued: bytes=42\n'
        )
      )

      expect(mockLogInfo).toHaveBeenCalledWith(
        {
          data: 'RPC-DIAG CUID#7 first WebSocket response queued: bytes=42',
        },
        'aria2 RPC diagnostic'
      )
    })

    it('calls onExit when process exits', async () => {
      const mockChild = createMockChildProcess()
      mockSpawnFn.mockReturnValue(mockChild)

      const onExit = vi.fn()
      manager.onExit = onExit

      await manager.spawn('/usr/bin/aria2c', [])

      // Simulate process exit
      mockChild._emit('exit', 0, null)

      expect(onExit).toHaveBeenCalledWith(0, null)
      expect(manager.isRunning()).toBe(false)
    })

    it('calls onError when process errors', async () => {
      const mockChild = createMockChildProcess()
      mockSpawnFn.mockReturnValue(mockChild)

      const onError = vi.fn()
      manager.onError = onError

      await manager.spawn('/usr/bin/aria2c', [])

      const err = new Error('spawn error')
      mockChild._emit('error', err)

      expect(onError).toHaveBeenCalledWith(err)
    })

    it('redacts credentials carried by spawn errors', async () => {
      const mockChild = createMockChildProcess()
      mockSpawnFn.mockReturnValue(mockChild)
      const args = [
        '--rpc-secret=rpc-secret-value',
        '--all-proxy=http://local-user:local-password@127.0.0.1:43123',
        '--all-proxy-user=local-user',
        '--all-proxy-passwd=local-password',
      ]
      await manager.spawn('/missing/aria2c', args)

      const err = Object.assign(new Error(`spawn failed: ${args.join(' ')}`), {
        code: 'ENOENT',
        errno: -2,
        path: '/missing/aria2c',
        spawnargs: args,
        syscall: 'spawn /missing/aria2c',
      })
      mockChild._emit('error', err)

      expect(mockLogError).toHaveBeenCalledWith(
        {
          err: expect.objectContaining({
            code: 'ENOENT',
            message:
              'spawn failed: --rpc-secret=<redacted> --all-proxy=<redacted> --all-proxy-user=<redacted> --all-proxy-passwd=<redacted>',
            spawnargs: [
              '--rpc-secret=<redacted>',
              '--all-proxy=<redacted>',
              '--all-proxy-user=<redacted>',
              '--all-proxy-passwd=<redacted>',
            ],
          }),
        },
        'aria2 process error'
      )
      const serializedLog = JSON.stringify(mockLogError.mock.calls)
      expect(serializedLog).not.toContain('rpc-secret-value')
      expect(serializedLog).not.toContain('local-password')
    })

    it('retains a bounded stderr tail for startup diagnosis and resets it on spawn', async () => {
      const firstChild = createMockChildProcess()
      const secondChild = createMockChildProcess()
      mockSpawnFn
        .mockReturnValueOnce(firstChild)
        .mockReturnValueOnce(secondChild)

      const sensitiveArgs = [
        '--rpc-secret=rpc-secret-value',
        '--all-proxy=http://local-user:local-password@127.0.0.1:43123',
        '--all-proxy-user=local-user',
        '--all-proxy-passwd=local-password',
      ]
      await manager.spawn('/usr/bin/aria2c', sensitiveArgs)
      const firstStderrHandler = firstChild.stderr.on.mock.calls[0]?.[1]
      firstStderrHandler?.(
        Buffer.from(
          `database disk image is malformed: ${sensitiveArgs.join(' ')}`
        )
      )
      expect(manager.getRecentStderr()).toContain(
        'database disk image is malformed'
      )
      expect(manager.getRecentStderr()).toContain('--rpc-secret=<redacted>')
      expect(manager.getRecentStderr()).toContain('--all-proxy=<redacted>')
      expect(manager.getRecentStderr()).toContain('--all-proxy-user=<redacted>')
      expect(manager.getRecentStderr()).toContain(
        '--all-proxy-passwd=<redacted>'
      )
      expect(manager.getRecentStderr()).not.toContain('rpc-secret-value')
      expect(manager.getRecentStderr()).not.toContain('local-password')

      await manager.spawn('/usr/bin/aria2c', [])
      expect(manager.getRecentStderr()).toBe('')
    })
  })

  describe('gracefulStop', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('sends SIGTERM and waits for exit', async () => {
      const mockChild = createMockChildProcess()
      mockSpawnFn.mockReturnValue(mockChild)

      await manager.spawn('/usr/bin/aria2c', [])

      // Override kill to simulate delayed exit
      let killSignal: string | undefined
      mockChild.kill = (signal?: string) => {
        killSignal = signal
        // Simulate exit after a small delay
        setTimeout(() => {
          mockChild._emit('exit', 0, signal ?? null)
        }, 100)
      }

      const stopPromise = manager.gracefulStop(5000)
      vi.advanceTimersByTime(100)
      await stopPromise

      expect(killSignal).toBe('SIGTERM')
      expect(manager.isRunning()).toBe(false)
    })

    it('is a no-op when not running', async () => {
      // Should not throw
      await manager.gracefulStop()
    })
  })

  describe('kill', () => {
    it('sends SIGKILL immediately', async () => {
      const mockChild = createMockChildProcess()
      mockSpawnFn.mockReturnValue(mockChild)

      await manager.spawn('/usr/bin/aria2c', [])

      manager.kill()

      expect(mockChild.killed).toBe(true)
      expect(manager.isRunning()).toBe(false)
    })

    it('is a no-op when not running', () => {
      // Should not throw
      manager.kill()
    })
  })

  describe('isRunning / getPid', () => {
    it('returns false and null before spawning', () => {
      expect(manager.isRunning()).toBe(false)
      expect(manager.getPid()).toBeNull()
    })
  })
})
