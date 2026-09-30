import { describe, expect, it, vi } from 'vitest'
import { createSystemShutdown } from './system-shutdown'

describe('system shutdown adapter', () => {
  it('never schedules or forces Windows shutdown', async () => {
    const run = vi.fn(async () => '')
    await createSystemShutdown(
      'win32',
      { SystemRoot: 'C:\\Windows' },
      run
    ).requestShutdown()
    expect(run).toHaveBeenCalledWith('C:\\Windows\\System32\\shutdown.exe', [
      '/s',
      '/t',
      '0',
    ])
  })

  it('probes Automation without performing a power action', async () => {
    const run = vi.fn(async () => 'System Events')
    const system = createSystemShutdown('darwin', {}, run)
    await system.probe()
    expect(run).toHaveBeenCalledWith('/usr/bin/osascript', [
      '-e',
      'tell application "System Events" to get name',
    ])
    await system.requestShutdown()
    expect(run).toHaveBeenLastCalledWith('/usr/bin/osascript', [
      '-e',
      'tell application "System Events" to shut down',
    ])
  })

  it.each(['s "challenge"', 's "no"', 's "na"', 's "inhibited"', 'unexpected'])(
    'rejects unattended Linux poweroff for %s',
    async (result) => {
      const run = vi.fn(async () => result)
      await expect(
        createSystemShutdown('linux', {}, run).probe()
      ).rejects.toThrow('not authorized')
      expect(run.mock.calls).toHaveLength(1)
    }
  )

  it('uses noninteractive logind poweroff', async () => {
    const run = vi.fn(async () => 's "yes"\n')
    const system = createSystemShutdown('linux', {}, run)
    await system.probe()
    await system.requestShutdown()
    expect(run.mock.calls[1]).toEqual([
      '/usr/bin/busctl',
      [
        '--system',
        'call',
        'org.freedesktop.login1',
        '/org/freedesktop/login1',
        'org.freedesktop.login1.Manager',
        'PowerOff',
        'b',
        'false',
      ],
    ])
  })

  it.each([{ SNAP: '/snap/motrix' }, { FLATPAK_ID: 'app.motrix.native' }])(
    'does not attempt to escape confined distributions',
    async (env) => {
      const run = vi.fn(async () => '')
      const system = createSystemShutdown('linux', env, run)
      expect(system.supported).toBe(false)
      await expect(system.probe()).rejects.toThrow('unavailable')
      await expect(system.requestShutdown()).rejects.toThrow('unavailable')
      expect(run).not.toHaveBeenCalled()
    }
  )
})
