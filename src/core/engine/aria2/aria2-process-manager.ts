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
const OWNER_MARKER_PREFIXES = [
  '--conf-path=',
  '--save-session=',
  '--sqlite3-db-path=',
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
  return args.map((arg) =>
    arg.startsWith('--rpc-secret=') ? '--rpc-secret=<redacted>' : arg
  )
}

export class Aria2ProcessManager {
  private process: ChildProcess | null = null
  private running = false
  private readonly ownershipFilePath: string | null
  private readonly inspector: Aria2ProcessInspector

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
      log.debug({ data: data.toString().trim() }, 'aria2 stdout')
    })

    child.stderr?.on('data', (data: Buffer) => {
      log.warn({ data: data.toString().trim() }, 'aria2 stderr')
    })

    child.on('exit', (code, signal) => {
      log.info({ code, signal }, 'aria2 process exited')
      this.running = false
      this.process = null
      if (child.pid) void this.clearOwnershipRecord(child.pid)
      this.onExit?.(code, signal)
    })

    child.on('error', (err) => {
      log.error({ err }, 'aria2 process error')
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

    if (
      this.isAria2(inspected) &&
      (recordMatches || executableMatches) &&
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
    return markerMatches >= 2 && Boolean(secret && commandLine.includes(secret))
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
