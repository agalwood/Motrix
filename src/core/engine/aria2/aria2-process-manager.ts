import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { execFile, spawn } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { getLogger } from '@core/logger'
import { AppError, ErrorCode } from '@shared/errors'
import {
  type EngineFeatureReport,
  type EngineProcessInfo,
  EngineProcessOwnership,
} from '@shared/types/engine'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import {
  Aria2ProcessInspector,
  type InspectedProcess,
} from './aria2-process-inspector'
import { buildFeatureReport } from './feature-report'

const log = getLogger('aria2')

const OWNER_RECORD_VERSION = 1
const STDERR_TAIL_LIMIT = 32 * 1024
const RPC_DIAGNOSTIC_MARKER = 'RPC-DIAG'
const OWNER_MARKER_PREFIXES = [
  '--conf-path=',
  '--save-session=',
  '--sqlite3-db-path=',
] as const
const REDACTED_ARG_PREFIXES = [
  '--rpc-secret=',
  '--all-proxy=',
  '--http-proxy-user=',
  '--http-proxy-passwd=',
  '--https-proxy-user=',
  '--https-proxy-passwd=',
  '--ftp-proxy-user=',
  '--ftp-proxy-passwd=',
  '--all-proxy-user=',
  '--all-proxy-passwd=',
] as const

const ownerRecordSchema = z.object({
  version: z.literal(OWNER_RECORD_VERSION),
  pid: z.number().int().positive(),
  binaryPath: z.string().min(1),
  rpcPort: z.number().int().min(1).max(65_535),
  argumentMarkers: z.array(z.string()).min(1),
  startedAt: z.number().int().positive(),
})

type OwnerRecord = z.infer<typeof ownerRecordSchema>

export interface Aria2ProcessManagerOptions {
  ownershipFilePath?: string
  inspector?: Aria2ProcessInspector
}

export interface ExpectedAria2Process {
  binaryPath: string
  args: string[]
}

function redactArgs(args: string[]): string[] {
  return args.map((arg) => {
    const prefix = REDACTED_ARG_PREFIXES.find((candidate) =>
      arg.startsWith(candidate)
    )
    return prefix ? `${prefix}<redacted>` : arg
  })
}

function redactSensitiveText(text: string, args: string[]): string {
  const sensitiveArgs = args.flatMap((arg) => {
    const prefix = REDACTED_ARG_PREFIXES.find((candidate) =>
      arg.startsWith(candidate)
    )
    return prefix ? [{ arg, prefix, value: arg.slice(prefix.length) }] : []
  })
  let redacted = text

  for (const { arg, prefix } of sensitiveArgs) {
    redacted = redacted.replaceAll(arg, `${prefix}<redacted>`)
  }
  for (const value of sensitiveArgs
    .map(({ value }) => value)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    redacted = redacted.replaceAll(value, '<redacted>')
  }
  return redacted
}

interface SpawnErrorDetails extends Error {
  code?: string
  errno?: string | number
  syscall?: string
  path?: string
  spawnargs?: unknown[]
}

function redactSpawnError(error: Error, fallbackArgs: string[]) {
  const details = error as SpawnErrorDetails
  const spawnargs = Array.isArray(details.spawnargs)
    ? details.spawnargs.filter((arg): arg is string => typeof arg === 'string')
    : fallbackArgs
  const candidateArgs = [...fallbackArgs, ...spawnargs]

  return {
    name: error.name,
    message: redactSensitiveText(error.message, candidateArgs),
    code: details.code,
    errno: details.errno,
    syscall: details.syscall,
    path: details.path,
    spawnargs: redactArgs(spawnargs),
  }
}

export class Aria2ProcessManager {
  private process: ChildProcess | null = null
  private running = false
  private readonly ownershipFilePath: string | null
  private readonly inspector: Aria2ProcessInspector
  private recentStderr = ''

  onExit: ((code: number | null, signal: string | null) => void) | null = null
  onError: ((err: Error) => void) | null = null

  constructor(options: Aria2ProcessManagerOptions = {}) {
    this.ownershipFilePath = options.ownershipFilePath ?? null
    this.inspector = options.inspector ?? new Aria2ProcessInspector()
  }

  async probe(binaryPath: string): Promise<EngineFeatureReport> {
    const versionOutput = await this.execForOutput(binaryPath, ['--version'])
    const report = this.parseVersionOutput(versionOutput)
    if (!report) {
      throw new AppError(
        ErrorCode.EngineStartFailed,
        `Unrecognized aria2 version output from ${binaryPath}`
      )
    }
    return report
  }

  private execForOutput(binaryPath: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(binaryPath, args, (err, stdout) => {
        if (err) {
          reject(
            new AppError(
              ErrorCode.EngineStartFailed,
              `Failed to probe aria2 binary at ${binaryPath}: ${err.message}`,
              err
            )
          )
          return
        }
        resolve(stdout)
      })
    })
  }

  async spawn(
    binaryPath: string,
    args: string[],
    env?: NodeJS.ProcessEnv
  ): Promise<void> {
    this.recentStderr = ''
    const options: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
    }
    if (env) options.env = env
    const child = spawn(binaryPath, args, options)

    this.process = child
    this.running = true

    log.info(
      { pid: child.pid, args: redactArgs(args) },
      'aria2 process spawned'
    )

    if (child.pid) {
      await this.writeOwnershipRecord(child.pid, binaryPath, args).catch(
        (err) => {
          log.warn({ err }, 'failed to persist aria2 ownership record')
        }
      )
    }

    child.stdout?.on('data', (data: Buffer) => {
      const text = redactSensitiveText(data.toString().trim(), args)
      if (text.includes(RPC_DIAGNOSTIC_MARKER)) {
        // Native RPC diagnostics are sparse (first queue/send per session and
        // exceptional states).  Promote only those lines into production logs;
        // ordinary aria2 stdout remains debug-only.
        log.info({ data: text }, 'aria2 RPC diagnostic')
      } else {
        log.debug({ data: text }, 'aria2 stdout')
      }
    })

    child.stderr?.on('data', (data: Buffer) => {
      const text = redactSensitiveText(data.toString(), args)
      this.recentStderr = `${this.recentStderr}${text}`.slice(
        -STDERR_TAIL_LIMIT
      )
      log.warn({ data: text.trim() }, 'aria2 stderr')
    })

    child.on('exit', (code, signal) => {
      log.info({ code, signal }, 'aria2 process exited')
      this.running = false
      this.process = null
      if (child.pid) void this.clearOwnershipRecord(child.pid)
      this.onExit?.(code, signal)
    })

    child.on('error', (err) => {
      log.error({ err: redactSpawnError(err, args) }, 'aria2 process error')
      this.running = false
      this.process = null
      if (child.pid) void this.clearOwnershipRecord(child.pid)
      this.onError?.(err)
    })
  }

  gracefulStop(timeoutMs = 5000): Promise<void> {
    const child = this.process
    if (!child || !this.running) {
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        // Timeout reached — force kill
        child.kill('SIGKILL')
      }, timeoutMs)

      const originalOnExit = this.onExit
      this.onExit = (code, signal) => {
        clearTimeout(timeout)
        this.onExit = originalOnExit
        originalOnExit?.(code, signal)
        resolve()
      }

      child.kill('SIGTERM')
    })
  }

  kill(): void {
    if (!this.process || !this.running) return
    this.process.kill('SIGKILL')
  }

  isRunning(): boolean {
    return this.running
  }

  getPid(): number | null {
    return this.process?.pid ?? null
  }

  /** Last bounded stderr tail from the current or most recent spawn attempt. */
  getRecentStderr(): string {
    return this.recentStderr
  }

  async inspectPort(
    port: number,
    expected: ExpectedAria2Process
  ): Promise<EngineProcessInfo | null> {
    const inspected = await this.inspector.inspectListeningPort(port)
    if (!inspected) return null

    const currentPid = this.getPid()
    if (this.running && currentPid === inspected.pid) {
      return this.toProcessInfo(
        inspected,
        EngineProcessOwnership.CurrentApp,
        true
      )
    }

    const record = await this.readOwnershipRecord()
    const executableMatches = this.executableMatches(
      inspected,
      expected.binaryPath
    )
    const launchFingerprintMatches = this.launchFingerprintMatches(
      inspected.commandLine,
      expected.args
    )
    const recordMatches =
      record?.pid === inspected.pid &&
      record.rpcPort === port &&
      this.samePath(record.binaryPath, expected.binaryPath) &&
      record.argumentMarkers.every((marker) => expected.args.includes(marker))
    const expectedUsesRpcSecret = expected.args.some((arg) =>
      arg.startsWith('--rpc-secret=')
    )
    // A private launch secret can authenticate a legacy orphan from the
    // bundled executable alone. In explicit no-token mode there is no private
    // marker, so require the mode-0600 ownership record before termination.
    const identityMatches =
      recordMatches || (expectedUsesRpcSecret && executableMatches)

    if (
      this.isAria2(inspected) &&
      identityMatches &&
      launchFingerprintMatches
    ) {
      return this.toProcessInfo(
        inspected,
        EngineProcessOwnership.VerifiedOrphan,
        true
      )
    }

    if (this.isAria2(inspected)) {
      return this.toProcessInfo(
        inspected,
        EngineProcessOwnership.ExternalAria2,
        false
      )
    }

    const ownership =
      inspected.name === 'unknown'
        ? EngineProcessOwnership.Unknown
        : EngineProcessOwnership.Other
    return this.toProcessInfo(inspected, ownership, false)
  }

  async forceTerminateVerified(
    expectedPid: number,
    port: number,
    expected: ExpectedAria2Process
  ): Promise<void> {
    const processInfo = await this.inspectPort(port, expected)
    if (
      !processInfo ||
      processInfo.pid !== expectedPid ||
      !processInfo.safeToTerminate
    ) {
      throw new AppError(
        ErrorCode.EngineProcessOwnershipUnverified,
        'The process changed or is not verified as Motrix-owned'
      )
    }

    if (
      processInfo.ownership === EngineProcessOwnership.CurrentApp &&
      this.getPid() === expectedPid
    ) {
      this.kill()
    } else {
      this.inspector.forceTerminate(expectedPid)
    }

    const deadline = Date.now() + 5_000
    while (this.inspector.isAlive(expectedPid) && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    if (this.inspector.isAlive(expectedPid)) {
      throw new AppError(
        ErrorCode.EngineProcessTerminationFailed,
        `aria2 process ${expectedPid} did not exit after force termination`
      )
    }
    await this.clearOwnershipRecord(expectedPid)
  }

  private toProcessInfo(
    inspected: InspectedProcess,
    ownership: EngineProcessOwnership,
    safeToTerminate: boolean
  ): EngineProcessInfo {
    return {
      pid: inspected.pid,
      name: inspected.name,
      executableName: inspected.executablePath
        ? path.basename(inspected.executablePath)
        : null,
      ownership,
      safeToTerminate,
    }
  }

  private isAria2(inspected: InspectedProcess): boolean {
    return [inspected.name, inspected.executablePath ?? ''].some((value) =>
      /(^|[/\\])aria2c(?:\.exe)?$/i.test(value)
    )
  }

  private executableMatches(
    inspected: InspectedProcess,
    expectedPath: string
  ): boolean {
    if (inspected.executablePath) {
      return this.samePath(inspected.executablePath, expectedPath)
    }
    return inspected.commandLine?.includes(expectedPath) ?? false
  }

  private launchFingerprintMatches(
    commandLine: string | null,
    expectedArgs: string[]
  ): boolean {
    if (!commandLine) return false
    const markerMatches = this.ownerMarkers(expectedArgs).filter((marker) =>
      commandLine.includes(marker)
    ).length
    const secret = expectedArgs.find((arg) => arg.startsWith('--rpc-secret='))
    const authenticationModeMatches = secret
      ? commandLine.includes(secret)
      : !/(?:^|[\s"'])--rpc-secret(?:=|\s)/.test(commandLine)
    return markerMatches >= 2 && authenticationModeMatches
  }

  private samePath(left: string, right: string): boolean {
    const normalize = (value: string) => {
      const normalized = path.normalize(value)
      return process.platform === 'win32'
        ? normalized.toLowerCase()
        : normalized
    }
    return normalize(left) === normalize(right)
  }

  private ownerMarkers(args: string[]): string[] {
    return args.filter((arg) =>
      OWNER_MARKER_PREFIXES.some((prefix) => arg.startsWith(prefix))
    )
  }

  private async writeOwnershipRecord(
    pid: number,
    binaryPath: string,
    args: string[]
  ): Promise<void> {
    if (!this.ownershipFilePath) return
    const portArg = args.find((arg) => arg.startsWith('--rpc-listen-port='))
    const rpcPort = Number(portArg?.slice('--rpc-listen-port='.length))
    const record = ownerRecordSchema.parse({
      version: OWNER_RECORD_VERSION,
      pid,
      binaryPath,
      rpcPort,
      argumentMarkers: this.ownerMarkers(args),
      startedAt: Date.now(),
    })
    await writeFileAtomic(this.ownershipFilePath, JSON.stringify(record), {
      mode: 0o600,
    })
  }

  private async readOwnershipRecord(): Promise<OwnerRecord | null> {
    if (!this.ownershipFilePath) return null
    try {
      const parsed = JSON.parse(await readFile(this.ownershipFilePath, 'utf8'))
      const result = ownerRecordSchema.safeParse(parsed)
      return result.success ? result.data : null
    } catch {
      return null
    }
  }

  private async clearOwnershipRecord(expectedPid: number): Promise<void> {
    if (!this.ownershipFilePath) return
    const current = await this.readOwnershipRecord()
    if (current && current.pid !== expectedPid) return
    await unlink(this.ownershipFilePath).catch(() => {})
  }

  private parseVersionOutput(stdout: string): EngineFeatureReport | null {
    const versionMatch = stdout.match(/aria2 version (\S+)/)
    if (!versionMatch) return null
    const version = versionMatch[1]

    const featuresMatch = stdout.match(/Enabled Features:\s*(.+)/)
    const features = featuresMatch
      ? featuresMatch[1].split(',').map((f) => f.trim())
      : []

    return buildFeatureReport(version, features)
  }
}
