import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  CliInstallCapability,
  type CliInstallPackageManager,
  type CliInstallRequest,
  CliPackageManager,
  CliToolPhase,
  CliToolReason,
  type CliToolStatus,
} from '@shared/types/cli-tool'
import {
  createCommandRunner,
  type RunCommand,
  type RunResult,
} from './command-runner'
import {
  CANONICAL_INSTALL_COMMAND,
  classifyCliInstall,
  discoverPackageManagers,
  isCliInstallPackageManager,
  locateManagerCliExecutable,
  type PackageManagerContext,
  type PackageManagerDiscovery,
  type PackageManagerSelection,
  packageManagerOption,
  unavailablePackageManagerOptions,
} from './package-manager'
import {
  resolveExecutable,
  ShellEnvironmentResolver,
  type ShellEnvironmentSource,
} from './shell-environment'

type ResolveRealpath = (value: string) => Promise<string>

interface CliToolServiceOptions {
  directInstallSupported: boolean
  manualOnlyReason?: CliToolReason
  platform?: NodeJS.Platform
  inheritedEnv?: NodeJS.ProcessEnv
  environment?: ShellEnvironmentSource
  run?: RunCommand
  resolve?: typeof resolveExecutable
  realpathPath?: ResolveRealpath
  neutralDir?: string
}

interface ProbeResult {
  status: CliToolStatus
  env: NodeJS.ProcessEnv
  discovery: PackageManagerDiscovery | null
}

interface VersionProbe {
  version: string | null
  result: RunResult
}

interface ManagerTargetProbe {
  executablePath: string | null
  version: string | null
}

const INSTALL_TIMEOUT_MS = 300_000
const CHECK_TIMEOUT_MS = 15_000
const INSTALL_OUTPUT_CAP = 128_000
const DETAIL_CAP = 12_000
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escape sequences from external process output
const ANSI_ESCAPE = /\x1b\[[0-?]*[ -/]*[@-~]/g

function baseStatus(
  values: Partial<CliToolStatus> & Pick<CliToolStatus, 'phase' | 'capability'>
): CliToolStatus {
  return {
    installCommand: CANONICAL_INSTALL_COMMAND,
    packageManager: CliPackageManager.Unknown,
    managerOptions: unavailablePackageManagerOptions(),
    version: null,
    executablePath: null,
    nodeVersion: null,
    reason: null,
    detail: null,
    ...values,
  }
}

function parseVersion(output: string): string | null {
  const match = output.trim().match(/^v?(\d+\.\d+\.\d+(?:[-+][^\s]+)?)$/)
  return match?.[1] ?? null
}

function parseNodeMajor(version: string | null): number | null {
  if (!version) return null
  const match = version.match(/^(\d+)\./)
  return match ? Number.parseInt(match[1], 10) : null
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function stripUnsafeControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return (
        code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
      )
    })
    .join('')
}

export function sanitizeCliDiagnostic(
  value: string,
  homeDirectory: string,
  platform: NodeJS.Platform = process.platform
): string {
  let sanitized = stripUnsafeControlCharacters(value.replace(ANSI_ESCAPE, ''))
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(
      /(["']?(?:_auth|_?authToken|token|password|_password)["']?\s*[=:]\s*["']?)[^\s"',}&]+/gi,
      '$1[redacted]'
    )
    .replace(/([?&](?:token|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(https?:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1[redacted]@')

  const homeIsAbsolute =
    platform === 'win32'
      ? path.win32.isAbsolute(homeDirectory)
      : path.isAbsolute(homeDirectory)
  if (homeDirectory && homeIsAbsolute) {
    const homeVariants =
      platform === 'win32'
        ? new Set([
            homeDirectory,
            homeDirectory.replaceAll('\\', '/'),
            homeDirectory.replaceAll('/', '\\'),
          ])
        : new Set([homeDirectory])
    for (const home of homeVariants) {
      sanitized = sanitized.replace(
        new RegExp(regexEscape(home), platform === 'win32' ? 'gi' : 'g'),
        '~'
      )
    }
  }
  return sanitized.slice(-DETAIL_CAP).trim()
}

function installFailureReason(result: RunResult): CliToolReason {
  if (result.timedOut) return CliToolReason.Timeout
  const output = `${result.stderr}\n${result.stdout}`
  if (
    result.spawnError?.code === 'EACCES' ||
    result.spawnError?.code === 'EPERM' ||
    /\b(?:EACCES|EPERM)\b/i.test(output)
  ) {
    return CliToolReason.Permission
  }
  if (
    /\b(?:EAI_AGAIN|ENETUNREACH|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|E404)\b|network|registry unavailable/i.test(
      output
    )
  ) {
    return CliToolReason.Network
  }
  return CliToolReason.InstallFailed
}

export class CliToolService {
  readonly #directInstallSupported: boolean
  readonly #manualOnlyReason: CliToolReason
  readonly #platform: NodeJS.Platform
  readonly #environment: ShellEnvironmentSource
  readonly #run: RunCommand
  readonly #resolve: typeof resolveExecutable
  readonly #realpathPath: ResolveRealpath
  readonly #neutralDir: string
  #installFlight: Promise<CliToolStatus> | null = null
  #current: CliToolStatus | null = null
  #stateGeneration = 0

  constructor(options: CliToolServiceOptions) {
    this.#directInstallSupported = options.directInstallSupported
    this.#manualOnlyReason = options.manualOnlyReason ?? CliToolReason.Sandboxed
    this.#platform = options.platform ?? process.platform
    const inheritedEnv = { ...(options.inheritedEnv ?? process.env) }
    this.#run =
      options.run ??
      createCommandRunner({
        platform: this.#platform,
        systemRoot: inheritedEnv.SystemRoot,
      })
    this.#resolve = options.resolve ?? resolveExecutable
    this.#realpathPath = options.realpathPath ?? realpath
    this.#neutralDir = options.neutralDir ?? homedir()
    this.#environment =
      options.environment ??
      new ShellEnvironmentResolver({
        inheritedEnv,
        platform: this.#platform,
        run: this.#run,
      })
  }

  async getStatus(): Promise<CliToolStatus> {
    if (this.#installFlight && this.#current) return this.#current
    const generation = this.#stateGeneration
    const result = await this.#probe(false)
    if (generation !== this.#stateGeneration && this.#current) {
      return this.#current
    }
    this.#current = result.status
    return result.status
  }

  install(request: CliInstallRequest): Promise<CliToolStatus> {
    const requestedManager = request?.packageManager
    if (!isCliInstallPackageManager(requestedManager)) {
      return Promise.resolve(
        baseStatus({
          ...(this.#current ?? {}),
          phase: CliToolPhase.Error,
          capability: this.#directInstallSupported
            ? CliInstallCapability.Direct
            : CliInstallCapability.ManualOnly,
          reason: CliToolReason.Unknown,
          detail: null,
        })
      )
    }
    if (this.#installFlight) return this.#installFlight

    ++this.#stateGeneration
    const previous = this.#current
    const requestedOption = packageManagerOption(requestedManager, false)
    this.#current = baseStatus({
      ...(previous ?? {}),
      phase: CliToolPhase.Installing,
      capability: this.#directInstallSupported
        ? CliInstallCapability.Direct
        : CliInstallCapability.ManualOnly,
      installCommand: requestedOption.installCommand,
      packageManager: requestedManager,
      reason: null,
      detail: null,
    })
    const flight = this.#performInstall(requestedManager).catch(
      (error: unknown) => {
        const detail = sanitizeCliDiagnostic(
          error instanceof Error ? error.message : String(error),
          this.#neutralDir,
          this.#platform
        )
        return baseStatus({
          ...(this.#current ?? {}),
          phase: CliToolPhase.Error,
          capability: this.#directInstallSupported
            ? CliInstallCapability.Direct
            : CliInstallCapability.ManualOnly,
          reason: CliToolReason.Unknown,
          detail: detail || null,
        })
      }
    )
    this.#installFlight = flight
    void flight.then((status) => {
      this.#current = status
      if (this.#installFlight === flight) this.#installFlight = null
    })
    return flight
  }

  async #performInstall(
    requestedManager: CliInstallPackageManager
  ): Promise<CliToolStatus> {
    const preflight = await this.#probe(true)
    if (preflight.status.phase !== CliToolPhase.Ready || !preflight.discovery) {
      if (preflight.status.phase === CliToolPhase.Installed) {
        if (!isCliInstallPackageManager(preflight.status.packageManager)) {
          return {
            ...preflight.status,
            installCommand: packageManagerOption(requestedManager, false)
              .installCommand,
          }
        }
        return preflight.status
      }
      const option = packageManagerOption(requestedManager, false)
      return baseStatus({
        ...preflight.status,
        installCommand: option.installCommand,
        packageManager: requestedManager,
      })
    }
    const manager = preflight.discovery.selections.get(requestedManager)
    if (!manager) {
      const option = packageManagerOption(requestedManager, false)
      return baseStatus({
        ...preflight.status,
        phase: CliToolPhase.NeedsAttention,
        capability: CliInstallCapability.ManualOnly,
        installCommand: option.installCommand,
        packageManager: requestedManager,
        reason: CliToolReason.ManagerMissing,
      })
    }

    const installing = baseStatus({
      ...preflight.status,
      phase: CliToolPhase.Installing,
      installCommand: manager.command,
      packageManager: manager.manager,
      reason: null,
      detail: null,
    })
    this.#current = installing
    const previousTarget = await this.#probeManagerTarget(
      manager,
      preflight.env
    )
    const result = await this.#run(manager.executablePath, manager.args, {
      cwd: this.#neutralDir,
      env: preflight.env,
      timeoutMs: INSTALL_TIMEOUT_MS,
      maxBuffer: INSTALL_OUTPUT_CAP,
    })

    const refreshedEnv = await this.#environment.resolve(true)
    const verified = await this.#verifyInstall(
      manager,
      refreshedEnv,
      preflight.status.nodeVersion,
      result,
      previousTarget,
      preflight.status.managerOptions
    )
    if (verified) return verified

    const diagnostic = sanitizeCliDiagnostic(
      `${result.stderr}\n${result.stdout}`,
      this.#neutralDir,
      this.#platform
    )
    return baseStatus({
      phase: CliToolPhase.Error,
      capability: CliInstallCapability.Direct,
      installCommand: manager.command,
      packageManager: manager.manager,
      managerOptions: preflight.status.managerOptions,
      nodeVersion: preflight.status.nodeVersion,
      reason:
        result.code === 0
          ? CliToolReason.VerifyFailed
          : installFailureReason(result),
      detail: diagnostic || null,
    })
  }

  async #probe(forceEnvironment: boolean): Promise<ProbeResult> {
    const env = await this.#environment.resolve(forceEnvironment)
    const nodePath = await this.#resolve('node', env, {
      platform: this.#platform,
    })
    const motrixPath = await this.#resolve('motrix', env, {
      platform: this.#platform,
    })
    const nodeProbe = nodePath
      ? await this.#runVersion(nodePath, env)
      : { version: null, result: this.#missingResult() }
    const nodeMajor = parseNodeMajor(nodeProbe.version)
    const nodeSupported = Boolean(
      nodePath && nodeProbe.version && nodeMajor !== null && nodeMajor >= 22
    )
    const cliProbe = motrixPath ? await this.#runVersion(motrixPath, env) : null

    if (motrixPath && cliProbe?.version && nodeSupported) {
      const managerContext = this.#managerContext(env)
      const manager = await classifyCliInstall(motrixPath, managerContext)
      return {
        status: baseStatus({
          phase: CliToolPhase.Installed,
          capability: this.#directInstallSupported
            ? CliInstallCapability.Direct
            : CliInstallCapability.ManualOnly,
          installCommand: isCliInstallPackageManager(manager)
            ? packageManagerOption(manager, false).installCommand
            : CANONICAL_INSTALL_COMMAND,
          packageManager: manager,
          version: cliProbe.version,
          executablePath: await this.#safeRealpath(motrixPath),
          nodeVersion: nodeProbe.version,
        }),
        env,
        discovery: null,
      }
    }

    if (!this.#directInstallSupported) {
      return {
        status: baseStatus({
          phase: CliToolPhase.ManualOnly,
          capability: CliInstallCapability.ManualOnly,
          nodeVersion: nodeProbe.version,
          reason: this.#manualOnlyReason,
        }),
        env,
        discovery: null,
      }
    }

    if (!nodePath || !nodeProbe.version) {
      const detail = motrixPath
        ? sanitizeCliDiagnostic(
            `${nodeProbe.result.stderr}\n${nodeProbe.result.stdout}`,
            this.#neutralDir,
            this.#platform
          )
        : null
      return {
        status: baseStatus({
          phase: CliToolPhase.NeedsAttention,
          capability: CliInstallCapability.ManualOnly,
          executablePath: motrixPath,
          reason: CliToolReason.NodeMissing,
          detail: detail || null,
        }),
        env,
        discovery: null,
      }
    }
    if (nodeMajor === null || nodeMajor < 22) {
      return {
        status: baseStatus({
          phase: CliToolPhase.NeedsAttention,
          capability: CliInstallCapability.ManualOnly,
          nodeVersion: nodeProbe.version,
          executablePath: motrixPath,
          reason: CliToolReason.NodeTooOld,
        }),
        env,
        discovery: null,
      }
    }

    if (motrixPath && cliProbe) {
      const detail = sanitizeCliDiagnostic(
        `${cliProbe.result.stderr}\n${cliProbe.result.stdout}`,
        this.#neutralDir,
        this.#platform
      )
      return {
        status: baseStatus({
          phase: CliToolPhase.NeedsAttention,
          capability: CliInstallCapability.ManualOnly,
          executablePath: motrixPath,
          nodeVersion: nodeProbe.version,
          reason: CliToolReason.VerifyFailed,
          detail: detail || null,
        }),
        env,
        discovery: null,
      }
    }

    const discovery = await discoverPackageManagers(this.#managerContext(env))
    const manager = discovery.defaultSelection
    if (!manager) {
      return {
        status: baseStatus({
          phase: CliToolPhase.ManualOnly,
          capability: CliInstallCapability.ManualOnly,
          nodeVersion: nodeProbe.version,
          managerOptions: discovery.options,
          reason: CliToolReason.ManagerMissing,
        }),
        env,
        discovery,
      }
    }
    return {
      status: baseStatus({
        phase: CliToolPhase.Ready,
        capability: CliInstallCapability.Direct,
        installCommand: manager.command,
        packageManager: manager.manager,
        managerOptions: discovery.options,
        nodeVersion: nodeProbe.version,
      }),
      env,
      discovery,
    }
  }

  async #verifyInstall(
    manager: PackageManagerSelection,
    env: NodeJS.ProcessEnv,
    nodeVersion: string | null,
    installResult: RunResult,
    previousTarget: ManagerTargetProbe,
    managerOptions: CliToolStatus['managerOptions']
  ): Promise<CliToolStatus | null> {
    const context = this.#managerContext(env)
    const activePath = await this.#resolve('motrix', env, {
      platform: this.#platform,
    })
    const target = await this.#probeManagerTarget(manager, env)
    const targetPath = target.executablePath
    const active = activePath
      ? await this.#runVersion(activePath, env)
      : { version: null, result: this.#missingResult() }
    const targetChanged = Boolean(
      targetPath &&
        target.version &&
        (!previousTarget.executablePath ||
          !previousTarget.version ||
          this.#normalizePath(targetPath) !==
            this.#normalizePath(previousTarget.executablePath) ||
          target.version !== previousTarget.version)
    )
    const targetVerifiedByInstall = installResult.code === 0 || targetChanged

    if (activePath && active.version) {
      if (targetVerifiedByInstall && targetPath && target.version) {
        const [activeReal, targetReal] = await Promise.all([
          this.#safeRealpath(activePath),
          this.#safeRealpath(targetPath),
        ])
        if (
          this.#normalizePath(activeReal) !== this.#normalizePath(targetReal) &&
          active.version !== target.version
        ) {
          return baseStatus({
            phase: CliToolPhase.NeedsAttention,
            capability: CliInstallCapability.ManualOnly,
            installCommand: manager.command,
            packageManager: manager.manager,
            managerOptions,
            version: active.version,
            executablePath: activeReal,
            nodeVersion,
            reason: CliToolReason.PathShadowed,
            detail: sanitizeCliDiagnostic(
              `active=${activeReal} (${active.version}); installed=${targetPath} (${target.version})`,
              this.#neutralDir,
              this.#platform
            ),
          })
        }
      }
      const installedManager = await classifyCliInstall(activePath, context)
      const warning =
        installResult.code === 0
          ? null
          : sanitizeCliDiagnostic(
              `${installResult.stderr}\n${installResult.stdout}`,
              this.#neutralDir,
              this.#platform
            ) || null
      return baseStatus({
        phase: CliToolPhase.Installed,
        capability: CliInstallCapability.Direct,
        installCommand: manager.command,
        packageManager:
          installedManager === CliPackageManager.Unknown
            ? manager.manager
            : installedManager,
        managerOptions,
        version: active.version,
        executablePath: await this.#safeRealpath(activePath),
        nodeVersion,
        detail: warning,
      })
    }

    if (targetVerifiedByInstall && targetPath && target.version) {
      return baseStatus({
        phase: CliToolPhase.NeedsAttention,
        capability: CliInstallCapability.ManualOnly,
        installCommand: manager.command,
        packageManager: manager.manager,
        managerOptions,
        version: target.version,
        // Its parent is the PATH entry the user needs. The realpath usually
        // points inside node_modules and would produce incorrect guidance.
        executablePath: targetPath,
        nodeVersion,
        reason: CliToolReason.PathMissing,
        detail: sanitizeCliDiagnostic(
          `installed=${targetPath}`,
          this.#neutralDir,
          this.#platform
        ),
      })
    }
    return null
  }

  async #probeManagerTarget(
    manager: PackageManagerSelection,
    env: NodeJS.ProcessEnv
  ): Promise<ManagerTargetProbe> {
    const executablePath = await locateManagerCliExecutable(
      manager,
      this.#managerContext(env)
    )
    if (!executablePath) return { executablePath: null, version: null }
    const probe = await this.#runVersion(executablePath, env)
    return { executablePath, version: probe.version }
  }

  #managerContext(env: NodeJS.ProcessEnv): PackageManagerContext {
    return {
      env,
      neutralDir: this.#neutralDir,
      platform: this.#platform,
      run: this.#run,
      resolve: this.#resolve,
      realpathPath: this.#realpathPath,
    }
  }

  async #runVersion(
    executablePath: string,
    env: NodeJS.ProcessEnv
  ): Promise<VersionProbe> {
    const result = await this.#run(executablePath, ['--version'], {
      cwd: this.#neutralDir,
      env,
      timeoutMs: CHECK_TIMEOUT_MS,
      maxBuffer: 64_000,
    })
    return {
      version: result.code === 0 ? parseVersion(result.stdout) : null,
      result,
    }
  }

  async #safeRealpath(value: string): Promise<string> {
    try {
      return await this.#realpathPath(value)
    } catch {
      return value
    }
  }

  #normalizePath(value: string): string {
    const normalized = value.replaceAll('\\', '/')
    return this.#platform === 'win32' ? normalized.toLowerCase() : normalized
  }

  #missingResult(): RunResult {
    return {
      code: null,
      stdout: '',
      stderr: '',
      commandMissing: true,
    }
  }
}
