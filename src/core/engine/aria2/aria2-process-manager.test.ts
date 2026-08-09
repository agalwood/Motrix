import { AppError, ErrorCode } from '@shared/errors'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ─── Mock child_process ──────────────────────────────────────
// vi.mock is hoisted to top of file, so variables used inside the
// factory must be declared with vi.hoisted() to avoid TDZ errors.

const { mockExecFile, mockSpawnFn } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockSpawnFn: vi.fn(),
}))

vi.mock('node:child_process', () => {
  return {
    execFile: mockExecFile,
    spawn: mockSpawnFn,
    default: { execFile: mockExecFile, spawn: mockSpawnFn },
  }
})

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

const ARIA2_VERSION_OUTPUT = `aria2 version 1.37.0
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
      expect(report.version).toBe('1.37.0')
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

      const spawnPromise = manager.spawn('/usr/bin/aria2c', [
        '--rpc-listen-port=16800',
        '--rpc-secret=test',
      ])

      // Simulate process ready (emitting no immediate error
      // means it's running). Resolve the promise by allowing
      // the microtask to settle. In real code, spawn resolves
      // immediately once the child process is created without error.

      await spawnPromise

      expect(mockSpawnFn).toHaveBeenCalledWith(
        '/usr/bin/aria2c',
        ['--rpc-listen-port=16800', '--rpc-secret=test'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
      expect(manager.isRunning()).toBe(true)
      expect(manager.getPid()).toBe(12345)
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
