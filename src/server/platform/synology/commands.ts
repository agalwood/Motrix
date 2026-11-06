import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { NasAuthDiagnostic } from '@shared/schemas/operator-auth'
import { validDsmUsername } from './validation'

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

/** POSIX identity only. Account activity is checked separately by DSM Web API. */
export async function readDsmPosixAccount(
  username: string,
  signal: AbortSignal
) {
  if (!validDsmUsername(username)) throw new DsmCommandError({})
  try {
    const options = {
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      cwd: '/',
      timeout: 1500,
      maxBuffer: 8192,
      signal,
      encoding: 'utf8' as const,
    }
    const [uidResult, groupsResult] = await Promise.all([
      execute('/usr/bin/id', ['-u', '--', username], options),
      execute('/usr/bin/id', ['-G', '--', username], options),
    ])
    const uid = uidResult.stdout.trim()
    const groups = groupsResult.stdout.trim().split(/\s+/)
    if (
      !/^[1-9]\d*$/.test(uid) ||
      Number(uid) >= 0xffffffff ||
      groups.length > 1024 ||
      groups.some((g) => !/^\d+$/.test(g))
    )
      throw new Error('Invalid POSIX account')
    return { uid: Number(uid), administrator: groups.includes('101') }
  } catch (error) {
    throw new DsmCommandError(error)
  }
}
