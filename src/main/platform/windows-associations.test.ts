import { type ChildProcess, execFile } from 'node:child_process'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createWindowsAssociationsClient } from './windows-associations'
import { createWindowsStartupTaskClient } from './windows-startup-task'

const resourcesPath = path.resolve('test resources')
const success = {
  version: 1,
  ok: true,
  packageIdentityPresent: true,
  mainAppAumid: 'Motrix.Store.Test_8wekyb3d8bbwe!Motrix',
  torrent: true,
  magnet: null,
}
type Execute = NonNullable<
  Parameters<typeof createWindowsAssociationsClient>[0]
>['execute']

function fixture(response: unknown) {
  const stdin = new PassThrough()
  const execute = vi.fn<NonNullable<Execute>>(
    (_file, _args, _options, done) => {
      stdin.on('finish', () => done(null, JSON.stringify(response), ''))
      return { stdin, kill: vi.fn() } as unknown as ChildProcess
    }
  )
  return { stdin, execute, resourcesPath }
}

describe('Windows associations client', () => {
  it('uses the bounded helper process with a fixed read-only request and EOF', async () => {
    const deps = fixture(success)
    expect(await createWindowsAssociationsClient(deps).query()).toEqual(success)
    expect(deps.stdin.read().toString()).toBe(
      '{"version":1,"op":"associations_query"}\n'
    )
    expect(deps.stdin.writableEnded).toBe(true)
    expect(deps.execute).toHaveBeenCalledExactlyOnceWith(
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
  })

  it.each([
    { ...success, mainAppAumid: 'Motrix.Store.Test_8wekyb3d8bbwe!Helper' },
    { ...success, torrent: 'true' },
    { ...success, magnet: undefined },
    { ...success, path: 'other.exe' },
    {
      version: 1,
      ok: true,
      taskId: 'MotrixStartup',
      state: 'enabled',
      packageIdentityPresent: true,
    },
    { version: 1, ok: false, code: 'task_unavailable' },
    { version: 1, ok: false, code: 'helper_timeout' },
  ])('rejects mismatched wire response %j', async (response) => {
    expect(
      await createWindowsAssociationsClient(fixture(response)).query()
    ).toEqual({
      version: 1,
      ok: false,
      code: 'invalid_response',
    })
  })

  it.each([
    { version: 1, ok: false, code: 'main_app_unavailable' },
    { version: 1, ok: false, code: 'winrt_failed', hresult: '0x80070005' },
  ])('preserves association failures %j', async (response) => {
    expect(
      await createWindowsAssociationsClient(fixture(response)).query()
    ).toEqual(response)
  })

  it.each([success, { version: 1, ok: false, code: 'main_app_unavailable' }])(
    'does not accept an association reply in the startup adapter',
    async (response) => {
      expect(
        await createWindowsStartupTaskClient(fixture(response)).request(
          'startup_query'
        )
      ).toEqual({
        version: 1,
        ok: false,
        code: 'invalid_response',
      })
    }
  )

  it('executes a real process that only responds after the fixed request and EOF', async () => {
    const execute: NonNullable<Execute> = (_file, _args, options, callback) =>
      execFile(
        process.execPath,
        [
          '-e',
          `
        let input = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', chunk => input += chunk);
        process.stdin.on('end', () => {
          const request = JSON.parse(input);
          if (request.op !== 'associations_query' || request.version !== 1 || Object.keys(request).length !== 2)
            process.exit(1);
          process.stdout.write(${JSON.stringify(JSON.stringify(success))});
        });
      `,
        ],
        options,
        callback
      )
    expect(
      await createWindowsAssociationsClient({ resourcesPath, execute }).query()
    ).toEqual(success)
  })
})
