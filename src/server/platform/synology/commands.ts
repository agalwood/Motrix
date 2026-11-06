import { spawn } from 'node:child_process'
import type { NasAuthDiagnostic } from '@shared/schemas/operator-auth'

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

/** The native broker accepts three fixed operations over stdin. No credential
 * enters argv or stderr. It never interprets a caller-provided executable path. */
export const dsmCommand: DsmCommand = async (file, args, env = {}, signal) => {
  const request =
    file === '/usr/syno/synoman/webman/modules/authenticate.cgi' &&
    args.length === 0
      ? { operation: 'session', context: env }
      : file === '/usr/syno/sbin/synouser' &&
          args.length === 2 &&
          args[0] === '--get'
        ? { operation: 'account', username: args[1] }
        : file === '/usr/syno/bin/synoacltool' &&
            args.length === 3 &&
            args[0] === '-get-perm'
          ? { operation: 'acl', path: args[1], username: args[2] }
          : undefined
  if (!request || signal?.aborted) throw new DsmCommandError({})
  const body = JSON.stringify(request)
  if (Buffer.byteLength(body) > 16 * 1024) throw new DsmCommandError({})
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      '/var/packages/Motrix/target/bin/motrix-dsm-authority',
      [],
      {
        cwd: '/',
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        stdio: ['pipe', 'pipe', 'ignore'],
      }
    )
    let settled = false
    let killed = false
    let size = 0
    const chunks: Buffer[] = []
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(new DsmCommandError(error))
      else resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const abort = () => {
      killed = true
      child.kill('SIGKILL')
      finish({ killed: true })
    }
    const timer = setTimeout(abort, 5000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.on('error', finish)
    child.stdin.on('error', () => finish({}))
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 32 * 1024) {
        child.kill('SIGKILL')
        finish({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
        return
      }
      chunks.push(chunk)
    })
    child.on('close', (code) =>
      finish(code === 0 && !killed ? undefined : { code, killed })
    )
    child.stdin.end(body)
  })
}

/** Startup-only diagnostic of the package account lookup. It grants nothing
 * and returns no account details; every real client still revalidates its owner. */
export async function probeDsmAuthority(
  command: DsmCommand = dsmCommand,
  packageUid = process.getuid?.()
) {
  try {
    const value = await command('/usr/syno/sbin/synouser', ['--get', 'motrix'])
    const name = /^User Name\s*:\s*\[motrix\]\s*$/m.test(value)
    const uid = /^User uid\s*:\s*\[(\d+)\]\s*$/m.exec(value)?.[1]
    return {
      accountLookupProbe:
        name && uid !== undefined && Number(uid) === packageUid
          ? 'passed'
          : 'failed',
    }
  } catch (error) {
    return {
      accountLookupProbe: 'failed',
      ...(error instanceof DsmCommandError
        ? {
            failure: error.failure,
            ...(error.exitCode !== undefined
              ? { exitCode: error.exitCode }
              : {}),
          }
        : {}),
    }
  }
}
