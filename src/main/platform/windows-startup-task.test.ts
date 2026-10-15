import { type ChildProcess, execFile } from 'node:child_process'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createWindowsStartupTaskClient } from './windows-startup-task'

const resourcesPath = path.resolve('test resources')
const success = {
  version: 1,
  ok: true,
  taskId: 'MotrixStartup',
  state: 'disabled',
  packageIdentityPresent: true,
}
type Execute = NonNullable<
  Parameters<typeof createWindowsStartupTaskClient>[0]
>['execute']
type Complete = Parameters<NonNullable<Execute>>[3]

function controlled() {
  const calls: Array<{ stdin: PassThrough; finish: Complete }> = []
  const execute = vi.fn<NonNullable<Execute>>(
    (_file, _args, _options, finish) => {
      const stdin = new PassThrough()
      calls.push({ stdin, finish })
      return { stdin, kill: vi.fn() } as unknown as ChildProcess
    }
  )
  return { execute, calls }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
const failed = (code: string) => ({ version: 1, ok: false, code })

describe('Windows startup task client', () => {
  it('uses a fixed absolute EXE, bounded execution, one JSON request and EOF', async () => {
    const { execute, calls } = controlled()
    const client = createWindowsStartupTaskClient({ resourcesPath, execute })
    const request = client.request('startup_enable')
    await tick()
    expect(execute).toHaveBeenCalledWith(
      path.join(resourcesPath, 'bin', 'motrix-windows-platform.exe'),
      [],
      {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
        timeout: 5_000,
        killSignal: 'SIGKILL',
        maxBuffer: 16 * 1024,
      },
      expect.any(Function)
    )
    expect(calls[0].stdin.read().toString()).toBe(
      '{"version":1,"op":"startup_enable"}\n'
    )
    expect(calls[0].stdin.writableEnded).toBe(true)
    calls[0].finish(null, JSON.stringify(success), '')
    expect(await request).toEqual(success)
  })

  it('serializes reads and mutations and recovers after a failed request', async () => {
    const { execute, calls } = controlled()
    const client = createWindowsStartupTaskClient({ resourcesPath, execute })
    const first = client.request('startup_query')
    const second = client.request('startup_disable')
    await tick()
    expect(execute).toHaveBeenCalledTimes(1)
    calls[0].finish(
      Object.assign(new Error('missing'), { cmd: 'fixture', code: 'ENOENT' }),
      '',
      ''
    )
    expect(await first).toEqual(failed('helper_unavailable'))
    await tick()
    expect(execute).toHaveBeenCalledTimes(2)
    expect(calls[1].stdin.read().toString()).toContain('startup_disable')
    calls[1].finish(null, JSON.stringify(success), '')
    expect(await second).toEqual(success)
  })

  it.each([
    'not JSON',
    JSON.stringify({ ...success, version: 2 }),
    JSON.stringify({ ...success, state: 'other' }),
    JSON.stringify({ ...success, packageIdentityPresent: false }),
    JSON.stringify(failed('helper_unavailable')),
    `${JSON.stringify(success)}\n${JSON.stringify(success)}`,
  ])('rejects response %s', async (stdout) => {
    const { execute, calls } = controlled()
    const request = createWindowsStartupTaskClient({
      resourcesPath,
      execute,
    }).request('startup_query')
    await tick()
    calls[0].finish(null, stdout, '')
    expect(await request).toEqual(failed('invalid_response'))
  })

  it.each([0, 1])(
    'preserves structured native failures with exit %s',
    async (exitCode) => {
      const { execute, calls } = controlled()
      const request = createWindowsStartupTaskClient({
        resourcesPath,
        execute,
      }).request('startup_query')
      await tick()
      const result = { ...failed('winrt_failed'), hresult: '0x80070005' }
      calls[0].finish(
        exitCode
          ? Object.assign(new Error('failed'), {
              cmd: 'fixture',
              code: exitCode,
            })
          : null,
        JSON.stringify(result),
        ''
      )
      expect(await request).toEqual(result)
    }
  )

  it.each([
    [{ code: 'ENOENT' }, 'helper_unavailable'],
    [{ code: 'EACCES' }, 'helper_unavailable'],
    [{ code: 'EPERM' }, 'helper_unavailable'],
    [{ code: 'EIO' }, 'helper_failed'],
    [{ code: 1 }, 'helper_failed'],
    [{ signal: 'SIGKILL' }, 'helper_failed'],
    [{ killed: true, signal: 'SIGKILL' }, 'helper_timeout'],
    [
      { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true },
      'output_limit',
    ],
  ] as const)(
    'does not accept success over process failure %j',
    async (properties, code) => {
      const { execute, calls } = controlled()
      const request = createWindowsStartupTaskClient({
        resourcesPath,
        execute,
      }).request('startup_query')
      await tick()
      calls[0].finish(
        Object.assign(new Error('failed'), { cmd: 'fixture' }, properties),
        JSON.stringify(success),
        ''
      )
      expect(await request).toEqual(failed(code))
    }
  )

  it('handles stdin failure without an unhandled stream error or false success', async () => {
    const { execute, calls } = controlled()
    const request = createWindowsStartupTaskClient({
      resourcesPath,
      execute,
    }).request('startup_query')
    await tick()
    calls[0].stdin.emit('error', new Error('write failed'))
    calls[0].finish(null, JSON.stringify(success), '')
    expect(await request).toEqual(failed('helper_failed'))
  })

  it('waits for a child to exit after a synchronous stdin failure before starting another', async () => {
    const completions: Complete[] = []
    const kill = vi.fn()
    const execute = vi.fn<NonNullable<Execute>>(
      (_file, _args, _options, finish) => {
        const stdin = new PassThrough()
        if (completions.length === 0) {
          vi.spyOn(stdin, 'end').mockImplementation(() => {
            throw new Error('input closed')
          })
        }
        completions.push(finish)
        return { stdin, kill } as unknown as ChildProcess
      }
    )
    const client = createWindowsStartupTaskClient({ resourcesPath, execute })
    const first = client.request('startup_query')
    const next = client.request('startup_disable')
    await tick()
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    expect(execute).toHaveBeenCalledTimes(1)
    completions[0](
      Object.assign(new Error('killed'), { cmd: 'fixture', killed: true }),
      '',
      ''
    )
    expect(await first).toEqual(failed('helper_failed'))
    await tick()
    expect(execute).toHaveBeenCalledTimes(2)
    completions[1](null, JSON.stringify(success), '')
    expect(await next).toEqual(success)
  })

  it('rejects a caller-selected operation without starting a process', async () => {
    const { execute } = controlled()
    const client = createWindowsStartupTaskClient({ resourcesPath, execute })
    expect(await client.request('launch' as never)).toEqual(
      failed('invalid_request')
    )
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects relative helper roots before spawning', async () => {
    const { execute } = controlled()
    const result = await createWindowsStartupTaskClient({
      resourcesPath: 'relative',
      execute,
    }).request('startup_query')
    expect(result).toEqual(failed('helper_unavailable'))
    expect(execute).not.toHaveBeenCalled()
  })

  it('normalizes synchronous process creation errors', async () => {
    const execute = vi.fn<NonNullable<Execute>>(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    })
    expect(
      await createWindowsStartupTaskClient({ resourcesPath, execute }).request(
        'startup_query'
      )
    ).toEqual(failed('helper_unavailable'))
  })

  it('rejects unbounded execution settings', () => {
    for (const value of [0, -1, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() =>
        createWindowsStartupTaskClient({ timeoutMs: value })
      ).toThrow()
      expect(() =>
        createWindowsStartupTaskClient({ maxOutputBytes: value })
      ).toThrow()
    }
  })
})

function nodeHelper(script: string): NonNullable<Execute> {
  return (_file, _args, options, callback) =>
    execFile(process.execPath, ['-e', script], options, callback)
}

describe('startup helper process lifecycle with a real Node fixture', () => {
  it('delivers EOF and reads a complete reply before allowing another request', async () => {
    const execute = nodeHelper(`
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        const request = JSON.parse(input);
        process.stdout.write(JSON.stringify({
          version: 1, ok: true, taskId: 'MotrixStartup',
          packageIdentityPresent: true,
          state: request.op === 'startup_enable' ? 'enabled' : 'disabled'
        }));
      });
    `)
    const client = createWindowsStartupTaskClient({ resourcesPath, execute })
    expect(await client.request('startup_enable')).toEqual({
      ...success,
      state: 'enabled',
    })
    expect(await client.request('startup_disable')).toEqual(success)
  })

  it('terminates a stuck process at the timeout', async () => {
    const execute = nodeHelper('setInterval(() => {}, 1000)')
    const client = createWindowsStartupTaskClient({
      resourcesPath,
      execute,
      timeoutMs: 100,
    })
    expect(await client.request('startup_query')).toEqual(
      failed('helper_timeout')
    )
  })

  it.each(['stdout', 'stderr'])(
    'bounds %s even if the helper never exits',
    async (stream) => {
      const execute = nodeHelper(
        `process.${stream}.write('x'.repeat(8192)); setInterval(() => {}, 1000)`
      )
      const client = createWindowsStartupTaskClient({
        resourcesPath,
        execute,
        maxOutputBytes: 256,
      })
      expect(await client.request('startup_query')).toEqual(
        failed('output_limit')
      )
    }
  )
})
