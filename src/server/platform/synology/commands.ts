import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { NasAuthDiagnostic } from '@shared/schemas/operator-auth'

const execute = promisify(execFile)
export class DsmCommandError extends Error {
  readonly failure: NonNullable<NasAuthDiagnostic['failure']>
  readonly exitCode?: number
  constructor(error: unknown) {
    super('DSM authority unavailable')
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined
    const killed =
      typeof error === 'object' &&
      error !== null &&
      'killed' in error &&
      error.killed === true
    this.failure =
      code === 'EACCES' || code === 'EPERM'
        ? 'accessDenied'
        : code === 'ENOENT'
          ? 'notFound'
          : killed
            ? 'timeout'
            : code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
              ? 'outputLimit'
              : typeof code === 'number' &&
                  Number.isInteger(code) &&
                  code >= 0 &&
                  code <= 255
                ? 'exit'
                : 'unavailable'
    if (this.failure === 'exit') this.exitCode = code as number
  }
}

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
      env: {
        PATH: '/usr/syno/bin:/usr/syno/sbin:/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        ...env,
      },
      cwd: '/',
      timeout: 4000,
      maxBuffer: 32 * 1024,
      signal,
      encoding: 'utf8',
    })
    return stdout
  } catch (error) {
    // Child errors can contain session cookies in spawn arguments/environment.
    throw new DsmCommandError(error)
  }
}
