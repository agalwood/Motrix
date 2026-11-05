import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export type DsmCommand = (
  file: string,
  args: string[],
  env?: Record<string, string>,
  signal?: AbortSignal
) => Promise<string>

/** Fixed executable paths and argument arrays only; never a shell or caller PATH.
 * Run as the package user. Missing permissions are a denial, not an escalation. */
export const dsmCommand: DsmCommand = async (file, args, env = {}, signal) => {
  try {
    const { stdout } = await execute(file, args, {
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', ...env },
      timeout: 4000,
      maxBuffer: 32 * 1024,
      signal,
      encoding: 'utf8',
    })
    return stdout
  } catch {
    // Child errors can contain session cookies in spawn arguments/environment.
    throw new Error('DSM authority unavailable')
  }
}
