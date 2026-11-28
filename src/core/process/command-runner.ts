import { spawn } from 'node:child_process'
import path from 'node:path'

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
  spawnError?: NodeJS.ErrnoException
  commandMissing?: boolean
  timedOut?: boolean
  truncated?: boolean
}

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  maxBuffer?: number
}

export type RunCommand = (
  command: string,
  args: readonly string[],
  options?: RunOptions
) => Promise<RunResult>

interface CommandRunnerDependencies {
  platform?: NodeJS.Platform
  systemRoot?: string
  spawnProcess?: typeof spawn
  killProcess?: typeof process.kill
}

const DEFAULT_MAX_BUFFER = 1_000_000
const PROCESS_KILL_GRACE_MS = 2_000
const TIMEOUT_FORCE_SETTLE_MS = 3_000
const WINDOWS_FALLBACK_ROOT = 'C:\\Windows'
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, '^$1')
}

export function escapeCmdArgument(
  argument: string,
  doubleEscapeMetaChars = false
): string {
  let escaped = `${argument}`
  escaped = escaped.replace(/(\\*)"/g, '$1$1\\"')
  escaped = escaped.replace(/(\\*)$/, '$1$1')
  escaped = `"${escaped}"`
  escaped = escaped.replace(CMD_META, '^$1')
  if (doubleEscapeMetaChars) escaped = escaped.replace(CMD_META, '^$1')
  return escaped
}

export function windowsSystemBinary(
  name: 'cmd.exe' | 'taskkill.exe',
  systemRoot: string | undefined
): string {
  const root =
    systemRoot && path.win32.isAbsolute(systemRoot)
      ? systemRoot
      : WINDOWS_FALLBACK_ROOT
  return path.win32.join(root, 'System32', name)
}

export function isCommandMissing(
  code: number | null,
  stderr: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'win32') return false
  return (
    code === 9009 ||
    /is not recognized as an internal or external command/i.test(stderr)
  )
}

function isAbsoluteForPlatform(
  command: string,
  platform: NodeJS.Platform
): boolean {
  return platform === 'win32'
    ? path.win32.isAbsolute(command)
    : path.isAbsolute(command)
}

function invalidCommandResult(command: string): RunResult {
  const error = new Error(
    `Command must be an absolute path: ${command}`
  ) as NodeJS.ErrnoException
  error.code = 'EINVAL'
  return { code: null, stdout: '', stderr: '', spawnError: error }
}

function appendTail(
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
  cap: number
): { value: Buffer<ArrayBufferLike>; truncated: boolean } {
  const combined = Buffer.concat([current, chunk])
  if (combined.byteLength <= cap) {
    return { value: combined, truncated: false }
  }
  return {
    value: combined.subarray(combined.byteLength - cap),
    truncated: true,
  }
}

export function createCommandRunner(
  dependencies: CommandRunnerDependencies = {}
): RunCommand {
  const platform = dependencies.platform ?? process.platform
  const spawnProcess = dependencies.spawnProcess ?? spawn
  const killProcess = dependencies.killProcess ?? process.kill.bind(process)
  const systemRoot = dependencies.systemRoot ?? process.env.SystemRoot

  return (command, args, options) => {
    if (!isAbsoluteForPlatform(command, platform)) {
      return Promise.resolve(invalidCommandResult(command))
    }

    return new Promise((resolve) => {
      const isWindows = platform === 'win32'
      const batchShim = isWindows && /\.(?:cmd|bat)$/i.test(command)
      const cap = Math.max(1, options?.maxBuffer ?? DEFAULT_MAX_BUFFER)
      let child: ReturnType<typeof spawn>

      try {
        child = spawnProcess(
          batchShim ? escapeCmdCommand(command) : command,
          batchShim
            ? args.map((argument) => escapeCmdArgument(argument, true))
            : [...args],
          {
            cwd: options?.cwd,
            env: options?.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: batchShim
              ? windowsSystemBinary('cmd.exe', systemRoot)
              : false,
            detached: !isWindows,
            windowsHide: isWindows,
          }
        )
      } catch (error) {
        const spawnError = error as NodeJS.ErrnoException
        resolve({
          code: null,
          stdout: '',
          stderr: '',
          spawnError,
          commandMissing: spawnError.code === 'ENOENT' || undefined,
        })
        return
      }

      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let truncated = false
      let timedOut = false
      let settled = false
      let timeout: NodeJS.Timeout | undefined
      let killGrace: NodeJS.Timeout | undefined
      let forceSettle: NodeJS.Timeout | undefined

      child.stdout?.on('data', (data: Buffer | string) => {
        const appended = appendTail(stdout, Buffer.from(data), cap)
        stdout = appended.value
        truncated ||= appended.truncated
      })
      child.stderr?.on('data', (data: Buffer | string) => {
        const appended = appendTail(stderr, Buffer.from(data), cap)
        stderr = appended.value
        truncated ||= appended.truncated
      })

      const finish = (result: Omit<RunResult, 'stdout' | 'stderr'>) => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        if (forceSettle) clearTimeout(forceSettle)
        // Once a timeout starts process-tree termination, keep the escalation
        // timer alive even if the direct child closes first. Descendants in the
        // detached process group may have ignored SIGTERM and still need the
        // delayed SIGKILL.
        if (killGrace && !timedOut) clearTimeout(killGrace)
        resolve({
          ...result,
          stdout: stdout.toString('utf8'),
          stderr: stderr.toString('utf8'),
          timedOut: timedOut || result.timedOut || undefined,
          truncated: truncated || undefined,
        })
      }

      const killTree = () => {
        const pid = child.pid
        if (pid == null) return
        if (isWindows) {
          try {
            const taskkill = spawnProcess(
              windowsSystemBinary('taskkill.exe', systemRoot),
              ['/pid', String(pid), '/t', '/f'],
              { stdio: 'ignore', shell: false, windowsHide: true }
            )
            // A failed spawn is normally reported asynchronously through the
            // child error event, outside the surrounding try/catch.
            taskkill.once('error', () => {})
          } catch {
            // Best effort: the child may have exited between timeout and kill.
          }
          killGrace = setTimeout(() => {
            try {
              child.kill('SIGKILL')
            } catch {
              // taskkill already terminated the process tree.
            }
          }, PROCESS_KILL_GRACE_MS)
          killGrace.unref?.()
          return
        }

        try {
          killProcess(-pid, 'SIGTERM')
        } catch {
          try {
            killProcess(pid, 'SIGTERM')
          } catch {
            return
          }
        }
        killGrace = setTimeout(() => {
          try {
            killProcess(-pid, 'SIGKILL')
          } catch {
            try {
              killProcess(pid, 'SIGKILL')
            } catch {
              // Already gone.
            }
          }
        }, PROCESS_KILL_GRACE_MS)
        killGrace.unref?.()
      }

      if (options?.timeoutMs && options.timeoutMs > 0) {
        timeout = setTimeout(() => {
          timedOut = true
          // Tree termination is best-effort. Guarantee the public timeout is
          // still an actual upper bound when the OS never delivers close/error.
          forceSettle = setTimeout(() => {
            finish({ code: null, timedOut: true })
          }, TIMEOUT_FORCE_SETTLE_MS)
          forceSettle.unref?.()
          killTree()
        }, options.timeoutMs)
        timeout.unref?.()
      }

      child.on('error', (spawnError: NodeJS.ErrnoException) => {
        finish({
          code: null,
          spawnError,
          commandMissing: spawnError.code === 'ENOENT' || undefined,
        })
      })
      child.on('close', (code) => {
        const stderrText = stderr.toString('utf8')
        finish({
          code,
          commandMissing:
            isCommandMissing(code, stderrText, platform) || undefined,
        })
      })
    })
  }
}

export const runCommand = createCommandRunner()
