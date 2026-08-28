import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createCommandRunner,
  escapeCmdArgument,
  escapeCmdCommand,
  isCommandMissing,
  windowsSystemBinary,
} from './command-runner'

describe('Windows command escaping', () => {
  it('matches cross-spawn escaping for paths and batch arguments', () => {
    expect(escapeCmdCommand('C:\\Program Files\\nodejs\\npm.cmd')).toBe(
      'C:\\Program^ Files\\nodejs\\npm.cmd'
    )
    expect(escapeCmdArgument('a&b', true)).toBe('^^^"a^^^&b^^^"')
    expect(escapeCmdArgument('@motrix/cli@latest', true)).toBe(
      '^^^"@motrix/cli@latest^^^"'
    )
  })

  it('uses only an absolute SystemRoot-derived system binary', () => {
    expect(windowsSystemBinary('cmd.exe', 'D:\\Windows')).toBe(
      'D:\\Windows\\System32\\cmd.exe'
    )
    expect(windowsSystemBinary('taskkill.exe', 'relative')).toBe(
      'C:\\Windows\\System32\\taskkill.exe'
    )
  })

  it('keeps missing-command detection narrow', () => {
    expect(isCommandMissing(9009, '', 'win32')).toBe(true)
    expect(isCommandMissing(1, 'npm error 404 Not Found', 'win32')).toBe(false)
    expect(isCommandMissing(9009, '', 'linux')).toBe(false)
  })
})

describe('createCommandRunner', () => {
  afterEach(() => vi.useRealTimers())

  it('rejects a bare command before spawning', async () => {
    const spawnProcess = vi.fn()
    const run = createCommandRunner({ spawnProcess: spawnProcess as never })

    await expect(run('npm', [])).resolves.toMatchObject({
      code: null,
      spawnError: { code: 'EINVAL' },
    })
    expect(spawnProcess).not.toHaveBeenCalled()
  })

  it('captures bounded output from an absolute executable', async () => {
    const run = createCommandRunner()
    const result = await run(
      process.execPath,
      ['-e', 'process.stdout.write("a".repeat(4096))'],
      { maxBuffer: 64 }
    )

    expect(result).toMatchObject({ code: 0, truncated: true })
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64)
  })

  it('spawns Windows executables directly when their path contains spaces', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    })
    const spawnProcess = vi.fn().mockReturnValue(child)
    const run = createCommandRunner({
      platform: 'win32',
      spawnProcess: spawnProcess as never,
    })

    const pending = run('C:\\Program Files\\nodejs\\node.EXE', ['--version'])
    child.emit('close', 0)

    await expect(pending).resolves.toMatchObject({ code: 0 })
    expect(spawnProcess).toHaveBeenCalledWith(
      'C:\\Program Files\\nodejs\\node.EXE',
      ['--version'],
      expect.objectContaining({
        shell: false,
        detached: false,
        windowsHide: true,
      })
    )
  })

  it('kills a timed-out POSIX process group', async () => {
    if (process.platform === 'win32') return
    const run = createCommandRunner()
    const result = await run(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 10_000)'],
      { timeoutMs: 100 }
    )
    expect(result.timedOut).toBe(true)
    expect(result.code).toBeNull()
  })

  it('still escalates a timed-out POSIX process group after the parent closes', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    })
    const spawnProcess = vi.fn().mockReturnValue(child)
    const killProcess = vi.fn()
    const run = createCommandRunner({
      platform: 'linux',
      spawnProcess: spawnProcess as never,
      killProcess,
    })

    const pending = run('/usr/bin/node', [], { timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(10)
    child.emit('close', null)

    await expect(pending).resolves.toMatchObject({
      code: null,
      timedOut: true,
    })
    expect(killProcess).toHaveBeenCalledWith(-42, 'SIGTERM')

    await vi.advanceTimersByTimeAsync(2_000)
    expect(killProcess).toHaveBeenCalledWith(-42, 'SIGKILL')
  })

  it('settles a timeout even when the child never emits close or error', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    })
    const killProcess = vi.fn()
    const run = createCommandRunner({
      platform: 'linux',
      spawnProcess: vi.fn().mockReturnValue(child) as never,
      killProcess,
    })

    const pending = run('/usr/bin/node', [], { timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(3_010)

    await expect(pending).resolves.toMatchObject({
      code: null,
      timedOut: true,
    })
    expect(killProcess).toHaveBeenCalledWith(-42, 'SIGTERM')
    expect(killProcess).toHaveBeenCalledWith(-42, 'SIGKILL')
  })

  it('uses absolute cmd.exe and taskkill.exe on Windows timeout', async () => {
    vi.useFakeTimers()
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    })
    const taskkill = Object.assign(new EventEmitter(), {
      pid: 43,
      stdout: null,
      stderr: null,
    })
    const spawnProcess = vi
      .fn()
      .mockReturnValueOnce(child)
      .mockReturnValueOnce(taskkill)
    const run = createCommandRunner({
      platform: 'win32',
      systemRoot: 'D:\\Windows',
      spawnProcess: spawnProcess as never,
    })

    const pending = run(
      'C:\\Program Files\\nodejs\\npm.cmd',
      ['install', '-g', '@motrix/cli@latest'],
      { timeoutMs: 10 }
    )
    await vi.advanceTimersByTimeAsync(10)
    expect(() =>
      taskkill.emit('error', new Error('spawn taskkill failed'))
    ).not.toThrow()
    child.emit('close', 1)

    await expect(pending).resolves.toMatchObject({ code: 1, timedOut: true })
    expect(spawnProcess.mock.calls[0]?.[2]).toMatchObject({
      shell: 'D:\\Windows\\System32\\cmd.exe',
    })
    expect(spawnProcess.mock.calls[1]?.[0]).toBe(
      'D:\\Windows\\System32\\taskkill.exe'
    )
    expect(spawnProcess.mock.calls[1]?.[1]).toEqual(['/pid', '42', '/t', '/f'])
  })
})
