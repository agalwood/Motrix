import {
  type ChildProcess,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
  execFile,
} from 'node:child_process'
import path from 'node:path'
import {
  type WindowsStartupTaskRequest,
  WindowsStartupTaskRequestSchema,
  WindowsStartupTaskResponseSchema,
  type WindowsStartupTaskResult,
} from '@shared/schemas/auto-launch'

type ExecuteHelper = (
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: (
    error: ExecFileException | null,
    stdout: string,
    stderr: string
  ) => void
) => ChildProcess

interface WindowsStartupTaskClientDeps {
  resourcesPath?: string
  execute?: ExecuteHelper
  timeoutMs?: number
  maxOutputBytes?: number
}

type FailureCode = Extract<WindowsStartupTaskResult, { ok: false }>['code']
const failure = (code: FailureCode): WindowsStartupTaskResult => ({
  version: 1,
  ok: false,
  code,
})

function executionFailure(error: unknown): WindowsStartupTaskResult {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return failure(
    code === 'ENOENT' || code === 'EACCES' || code === 'EPERM'
      ? 'helper_unavailable'
      : 'helper_failed'
  )
}

export function createWindowsStartupTaskClient(
  deps: WindowsStartupTaskClientDeps = {}
) {
  const execute = deps.execute ?? execFile
  const timeout = deps.timeoutMs ?? 5_000
  const maxBuffer = deps.maxOutputBytes ?? 16 * 1024
  if (!Number.isSafeInteger(timeout) || timeout <= 0)
    throw new Error('Startup helper timeout must be positive')
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer <= 0)
    throw new Error('Startup helper output limit must be positive')
  let tail: Promise<unknown> = Promise.resolve()

  function run(
    op: WindowsStartupTaskRequest['op']
  ): Promise<WindowsStartupTaskResult> {
    const request = WindowsStartupTaskRequestSchema.safeParse({
      version: 1,
      op,
    })
    if (!request.success) return Promise.resolve(failure('invalid_request'))
    const resources = deps.resourcesPath ?? process.resourcesPath
    if (!resources || !path.isAbsolute(resources))
      return Promise.resolve(failure('helper_unavailable'))
    const executable = path.join(
      resources,
      'bin',
      'motrix-windows-platform.exe'
    )

    return new Promise((resolve) => {
      let inputFailed = false
      let child: ChildProcess | undefined
      try {
        child = execute(
          executable,
          [],
          {
            encoding: 'utf8',
            shell: false,
            windowsHide: true,
            timeout,
            killSignal: 'SIGKILL',
            maxBuffer,
          },
          (error, stdout) => {
            if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
              resolve(failure('output_limit'))
              return
            }
            if (error?.killed) {
              resolve(failure(inputFailed ? 'helper_failed' : 'helper_timeout'))
              return
            }
            if (error?.signal) {
              resolve(failure('helper_failed'))
              return
            }
            if (error && typeof error.code !== 'number') {
              resolve(executionFailure(error))
              return
            }
            try {
              const parsed = WindowsStartupTaskResponseSchema.safeParse(
                JSON.parse(stdout)
              )
              if (!parsed.success) resolve(failure('invalid_response'))
              // A failing helper may return a structured WinRT error. A
              // successful-looking payload cannot override process failure.
              else if (parsed.data.ok && (error || inputFailed))
                resolve(failure('helper_failed'))
              else resolve(parsed.data)
            } catch {
              resolve(failure('invalid_response'))
            }
          }
        )
        if (!child.stdin) {
          inputFailed = true
          child.kill('SIGKILL')
          return
        }
        child.stdin.once('error', () => {
          inputFailed = true
        })
        child.stdin.end(`${JSON.stringify(request.data)}\n`)
      } catch (error) {
        if (child) {
          // Keep the queue occupied until execFile observes process exit.
          inputFailed = true
          child.kill('SIGKILL')
        } else resolve(executionFailure(error))
      }
    })
  }

  return {
    request(op: WindowsStartupTaskRequest['op']) {
      // execFile's callback runs after the child closes, including timeout or
      // output-limit termination. The next process cannot overlap this one.
      const result = tail.then(() => run(op))
      tail = result.then(
        () => undefined,
        () => undefined
      )
      return result
    },
  }
}

const client = createWindowsStartupTaskClient()
export const requestWindowsStartupTask = client.request
