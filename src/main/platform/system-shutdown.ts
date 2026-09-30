import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
type Run = (file: string, args: string[]) => Promise<string>
const runCommand: Run = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, {
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 64 * 1024,
    encoding: 'utf8',
  })
  return stdout
}

const LOGIND = [
  '--system',
  'call',
  'org.freedesktop.login1',
  '/org/freedesktop/login1',
  'org.freedesktop.login1.Manager',
]

/** Fixed commands only; never invoke a shell or interpolate task/user input. */
export function createSystemShutdown(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  run: Run = runCommand
) {
  const supported =
    ['darwin', 'win32', 'linux'].includes(platform) &&
    !env.FLATPAK_ID &&
    !env.SNAP
  return {
    supported: Boolean(supported),
    async probe(): Promise<void> {
      if (!supported)
        throw new Error('System shutdown is unavailable in this distribution')
      if (platform === 'darwin') {
        // Request Automation access while the user is enabling the feature.
        await run('/usr/bin/osascript', [
          '-e',
          'tell application "System Events" to get name',
        ])
      } else if (platform === 'linux') {
        const result = await run('/usr/bin/busctl', [...LOGIND, 'CanPowerOff'])
        if (result.trim() !== 's "yes"')
          throw new Error('Unattended shutdown is not authorized')
      }
    },
    async requestShutdown(): Promise<void> {
      if (!supported)
        throw new Error('System shutdown is unavailable in this distribution')
      if (platform === 'win32') {
        // A positive /t implies /f. The cancellable countdown belongs to Motrix.
        await run(
          path.win32.join(
            env.SystemRoot ?? 'C:\\Windows',
            'System32',
            'shutdown.exe'
          ),
          ['/s', '/t', '0']
        )
      } else if (platform === 'darwin') {
        await run('/usr/bin/osascript', [
          '-e',
          'tell application "System Events" to shut down',
        ])
      } else {
        await run('/usr/bin/busctl', [...LOGIND, 'PowerOff', 'b', 'false'])
      }
    },
  }
}
