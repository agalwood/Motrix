import { describe, expect, it, vi } from 'vitest'
import { registerSafariBootstrap } from './safari-bootstrap-registration'

const executablePath = '/Applications/Motrix.app/Contents/MacOS/Motrix'
function harness() {
  const run = vi.fn(async (file: string, args: readonly string[]) => {
    if (file.endsWith('MotrixSafariRegistrar'))
      return {
        stdout: JSON.stringify({ protocolVersion: 1, status: 'enabled' }),
        stderr: '',
      }
    return {
      stdout: '',
      stderr: args.includes('-d') ? 'TeamIdentifier=ABCDEFGHIJ\n' : '',
    }
  })
  return {
    platform: 'darwin' as const,
    isPackaged: true,
    executablePath,
    run,
    exists: vi.fn(async () => true),
  }
}

describe('packaged Safari bootstrap registration', () => {
  it('does nothing on other platforms, unpackaged apps, or missing registrar', async () => {
    const options = harness()
    for (const override of [
      { platform: 'linux' as const },
      { isPackaged: false },
      { executablePath: '/usr/bin/node' },
    ])
      expect(await registerSafariBootstrap({ ...options, ...override })).toBe(
        'not-bundled'
      )
    options.exists.mockResolvedValue(false)
    expect(await registerSafariBootstrap(options)).toBe('not-bundled')
    expect(options.run).not.toHaveBeenCalled()
  })

  it('verifies the parent and Team/group-bound registrar before invoking it', async () => {
    const options = harness()
    expect(await registerSafariBootstrap(options)).toBe('enabled')
    expect(options.run.mock.calls.map(([file]) => file)).toEqual([
      '/usr/bin/codesign',
      '/usr/bin/codesign',
      '/usr/bin/codesign',
      '/Applications/Motrix.app/Contents/MacOS/MotrixSafariRegistrar',
    ])
    expect(options.run.mock.calls[2]?.[1]).toContain(
      '=anchor apple generic and certificate leaf[subject.OU] = "ABCDEFGHIJ" and identifier "app.motrix.safari.registration" and entitlement["com.apple.security.application-groups"] = "ABCDEFGHIJ.app.motrix.shared"'
    )
    expect(options.run.mock.calls[3]?.[1]).toEqual(['--register'])
  })

  it.each([0, 2])(
    'does not execute the registrar if signature verification %s fails',
    async (index) => {
      const options = harness()
      const original = options.run.getMockImplementation()!
      let call = 0
      options.run.mockImplementation(async (...args) => {
        if (call++ === index) throw new Error('untrusted signature')
        return original(...args)
      })
      expect(await registerSafariBootstrap(options)).toBe('failed')
      expect(
        options.run.mock.calls.every(([file]) => file === '/usr/bin/codesign')
      ).toBe(true)
    }
  )

  it('rejects an absent or malformed Team without invoking a registrar', async () => {
    const options = harness()
    options.run.mockResolvedValue({
      stdout: '',
      stderr: 'TeamIdentifier=not set\n',
    })
    expect(await registerSafariBootstrap(options)).toBe('failed')
    expect(options.run).toHaveBeenCalledTimes(2)
  })

  it.each([
    [{ protocolVersion: 1, status: 'requires-approval' }, 'requires-approval'],
    [{ protocolVersion: 2, status: 'enabled' }, 'failed'],
    [{ protocolVersion: 1, status: 'enabled', extra: true }, 'failed'],
    [{ protocolVersion: 1, status: 'unknown' }, 'failed'],
    [null, 'failed'],
  ])(
    'bounds the registration result to the supported contract',
    async (response, expected) => {
      const options = harness()
      const original = options.run.getMockImplementation()!
      options.run.mockImplementation(async (file, args) =>
        file.endsWith('MotrixSafariRegistrar')
          ? { stdout: JSON.stringify(response), stderr: '' }
          : original(file, args)
      )
      expect(await registerSafariBootstrap(options)).toBe(expected)
    }
  )
})
