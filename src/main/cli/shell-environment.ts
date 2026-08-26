import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { userInfo } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { RunCommand } from './command-runner'
import { runCommand } from './command-runner'

interface ExecutableLookupDependencies {
  platform?: NodeJS.Platform
  accessFile?: typeof access
  statFile?: typeof stat
}

export interface ShellEnvironmentResolverOptions {
  inheritedEnv?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  run?: RunCommand
  getLoginShell?: () => string | null
  readWindowsPaths?: () => Promise<readonly string[]>
  accessFile?: typeof access
  statFile?: typeof stat
}

export interface ShellEnvironmentSource {
  resolve(forceRefresh?: boolean): Promise<NodeJS.ProcessEnv>
}

const SHELL_ENV_MARKER = '__MOTRIX_CLI_ENV__'
const SHELL_ENV_COMMAND = `printf '${SHELL_ENV_MARKER}\\000'; env -0`
const WINDOWS_FALLBACK_ROOT = 'C:\\Windows'
const WINDOWS_PATH_REGISTRY_KEYS = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
] as const
const execFileAsync = promisify(execFile)

function envValue(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform
): string | undefined {
  if (platform !== 'win32') return env[key]
  const actualKey = Object.keys(env).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase()
  )
  return actualKey ? env[actualKey] : undefined
}

async function isExecutableFile(
  candidate: string,
  platform: NodeJS.Platform,
  dependencies: ExecutableLookupDependencies
): Promise<boolean> {
  const accessFile = dependencies.accessFile ?? access
  const statFile = dependencies.statFile ?? stat
  try {
    await accessFile(
      candidate,
      platform === 'win32' ? constants.F_OK : constants.X_OK
    )
    return (await statFile(candidate)).isFile()
  } catch {
    return false
  }
}

function stripPathQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value
}

function parseWindowsRegistryPath(output: string): string | null {
  return (
    /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*?)\s*$/imu.exec(output)?.[1] ?? null
  )
}

async function readWindowsRegistryPaths(
  inheritedEnv: NodeJS.ProcessEnv
): Promise<readonly string[]> {
  const configuredRoot = envValue(inheritedEnv, 'SystemRoot', 'win32')
  const systemRoot =
    configuredRoot && path.win32.isAbsolute(configuredRoot)
      ? configuredRoot
      : WINDOWS_FALLBACK_ROOT
  const regExe = path.win32.join(systemRoot, 'System32', 'reg.exe')
  const results = await Promise.allSettled(
    WINDOWS_PATH_REGISTRY_KEYS.map((key) =>
      execFileAsync(regExe, ['query', key, '/v', 'Path'], {
        timeout: 2_000,
        windowsHide: true,
        maxBuffer: 128_000,
      })
    )
  )

  return results.flatMap((result) => {
    if (result.status !== 'fulfilled') return []
    const value = parseWindowsRegistryPath(result.value.stdout.toString())
    return value ? [value] : []
  })
}

function expandWindowsEnvironmentVariables(
  value: string,
  env: NodeJS.ProcessEnv
): string {
  return value.replace(/%([^%]+)%/g, (match, key: string) => {
    return envValue(env, key, 'win32') ?? match
  })
}

function mergeWindowsPaths(
  inheritedEnv: NodeJS.ProcessEnv,
  registryPaths: readonly string[]
): NodeJS.ProcessEnv {
  const inheritedPath = envValue(inheritedEnv, 'PATH', 'win32') ?? ''
  const paths = inheritedPath.split(';').filter(Boolean)
  const knownPaths = new Set(
    paths.map((value) =>
      stripPathQuotes(value)
        .replace(/[\\/]+$/, '')
        .toLowerCase()
    )
  )

  for (const registryPath of registryPaths) {
    for (const rawValue of registryPath.split(';')) {
      if (!rawValue) continue
      const value = expandWindowsEnvironmentVariables(rawValue, inheritedEnv)
      const normalized = stripPathQuotes(value)
        .replace(/[\\/]+$/, '')
        .toLowerCase()
      if (!normalized || knownPaths.has(normalized)) continue
      knownPaths.add(normalized)
      paths.push(value)
    }
  }

  const pathKey =
    Object.keys(inheritedEnv).find(
      (candidate) => candidate.toLowerCase() === 'path'
    ) ?? 'PATH'
  return { ...inheritedEnv, [pathKey]: paths.join(';') }
}

export async function resolveExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  dependencies: ExecutableLookupDependencies = {}
): Promise<string | null> {
  const platform = dependencies.platform ?? process.platform
  const pathApi = platform === 'win32' ? path.win32 : path

  if (pathApi.isAbsolute(name)) {
    return (await isExecutableFile(name, platform, dependencies)) ? name : null
  }
  if (name.includes('/') || name.includes('\\')) return null

  const pathValue = envValue(env, 'PATH', platform) ?? ''
  const separator = platform === 'win32' ? ';' : path.delimiter
  const directories = pathValue.split(separator).filter(Boolean)
  const hasExtension = platform === 'win32' && path.win32.extname(name) !== ''
  const extensions =
    platform === 'win32' && !hasExtension
      ? (envValue(env, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
      : ['']

  for (const rawDirectory of directories) {
    const directory = stripPathQuotes(rawDirectory)
    if (!pathApi.isAbsolute(directory)) continue
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, `${name}${extension}`)
      if (await isExecutableFile(candidate, platform, dependencies)) {
        return candidate
      }
    }
  }
  return null
}

export function parseNullDelimitedEnvironment(
  output: string
): NodeJS.ProcessEnv {
  const parsed: NodeJS.ProcessEnv = {}
  for (const entry of output.split('\0')) {
    if (!entry) continue
    const equals = entry.indexOf('=')
    if (equals <= 0) continue
    const key = entry.slice(0, equals)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    parsed[key] = entry.slice(equals + 1)
  }
  return parsed
}

function parseShellEnvironment(output: string): NodeJS.ProcessEnv | null {
  const marker = `${SHELL_ENV_MARKER}\0`
  const markerIndex = output.indexOf(marker)
  if (markerIndex < 0) return null
  return parseNullDelimitedEnvironment(
    output.slice(markerIndex + marker.length)
  )
}

function getDefaultLoginShell(env: NodeJS.ProcessEnv): string | null {
  if (env.SHELL) return env.SHELL
  try {
    return userInfo().shell || null
  } catch {
    return null
  }
}

export class ShellEnvironmentResolver implements ShellEnvironmentSource {
  readonly #inheritedEnv: NodeJS.ProcessEnv
  readonly #platform: NodeJS.Platform
  readonly #run: RunCommand
  readonly #getLoginShell: () => string | null
  readonly #readWindowsPaths: () => Promise<readonly string[]>
  readonly #lookupDependencies: ExecutableLookupDependencies
  #cached: NodeJS.ProcessEnv | null = null

  constructor(options: ShellEnvironmentResolverOptions = {}) {
    this.#inheritedEnv = { ...(options.inheritedEnv ?? process.env) }
    this.#platform = options.platform ?? process.platform
    this.#run = options.run ?? runCommand
    this.#getLoginShell =
      options.getLoginShell ?? (() => getDefaultLoginShell(this.#inheritedEnv))
    this.#readWindowsPaths =
      options.readWindowsPaths ??
      (() => readWindowsRegistryPaths(this.#inheritedEnv))
    this.#lookupDependencies = {
      platform: this.#platform,
      accessFile: options.accessFile,
      statFile: options.statFile,
    }
  }

  async resolve(forceRefresh = false): Promise<NodeJS.ProcessEnv> {
    const inherited = { ...this.#inheritedEnv }
    if (this.#platform === 'win32') {
      try {
        return mergeWindowsPaths(inherited, await this.#readWindowsPaths())
      } catch {
        return inherited
      }
    }

    if (!forceRefresh && this.#cached) return { ...this.#cached }

    const shell = this.#getLoginShell()
    if (!shell || !path.isAbsolute(shell)) {
      this.#cached = inherited
      return { ...inherited }
    }
    const executable = await resolveExecutable(
      shell,
      inherited,
      this.#lookupDependencies
    )
    if (!executable) {
      this.#cached = inherited
      return { ...inherited }
    }

    const result = await this.#run(
      executable,
      ['-i', '-l', '-c', SHELL_ENV_COMMAND],
      {
        env: inherited,
        timeoutMs: 10_000,
        maxBuffer: 512_000,
      }
    )
    if (result.code !== 0 || result.timedOut || result.truncated) {
      this.#cached = inherited
      return { ...inherited }
    }

    const shellEnvironment = parseShellEnvironment(result.stdout)
    if (!shellEnvironment) {
      this.#cached = inherited
      return { ...inherited }
    }
    this.#cached = {
      ...inherited,
      ...shellEnvironment,
    }
    return { ...this.#cached }
  }
}
