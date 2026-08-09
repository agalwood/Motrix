import { realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  CLI_INSTALL_PACKAGE_MANAGERS,
  type CliInstallPackageManager,
  CliPackageManager,
  type CliPackageManagerOption,
} from '@shared/types/cli-tool'
import type { RunCommand } from './command-runner'
import { resolveExecutable } from './shell-environment'

type ResolveRealpath = (value: string) => Promise<string>

export const CLI_PACKAGE_SPEC = '@motrix/cli@latest'
export const CANONICAL_INSTALL_COMMAND = `npm install -g ${CLI_PACKAGE_SPEC}`

export interface PackageManagerSelection {
  manager: CliInstallPackageManager
  executablePath: string
  args: readonly string[]
  command: string
}

export interface PackageManagerDiscovery {
  options: CliPackageManagerOption[]
  selections: ReadonlyMap<CliInstallPackageManager, PackageManagerSelection>
  defaultSelection: PackageManagerSelection | null
}

export interface PackageManagerContext {
  env: NodeJS.ProcessEnv
  neutralDir: string
  platform?: NodeJS.Platform
  run: RunCommand
  resolve?: typeof resolveExecutable
  realpathPath?: ResolveRealpath
}

interface ManagerDefinition {
  manager: CliInstallPackageManager
  binary: string
  args: readonly string[]
}

const MANAGERS: Record<CliInstallPackageManager, ManagerDefinition> = {
  [CliPackageManager.Npm]: {
    manager: CliPackageManager.Npm,
    binary: 'npm',
    args: ['install', '-g', CLI_PACKAGE_SPEC],
  },
  [CliPackageManager.Pnpm]: {
    manager: CliPackageManager.Pnpm,
    binary: 'pnpm',
    args: ['add', '-g', CLI_PACKAGE_SPEC],
  },
  [CliPackageManager.Yarn]: {
    manager: CliPackageManager.Yarn,
    binary: 'yarn',
    args: ['global', 'add', CLI_PACKAGE_SPEC],
  },
  [CliPackageManager.Bun]: {
    manager: CliPackageManager.Bun,
    binary: 'bun',
    args: ['add', '-g', CLI_PACKAGE_SPEC],
  },
  [CliPackageManager.Volta]: {
    manager: CliPackageManager.Volta,
    binary: 'volta',
    args: ['install', CLI_PACKAGE_SPEC],
  },
}

function normalizePath(value: string, platform: NodeJS.Platform): string {
  const normalized = value.replaceAll('\\', '/')
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function withSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}

function isAbsolutePath(value: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32'
    ? path.win32.isAbsolute(value)
    : path.isAbsolute(value)
}

async function safeRealpath(
  value: string,
  resolveRealpath: ResolveRealpath
): Promise<string> {
  try {
    return await resolveRealpath(value)
  } catch {
    return value
  }
}

async function npmGlobalRoot(
  context: PackageManagerContext
): Promise<string | null> {
  const resolve = context.resolve ?? resolveExecutable
  const npm = await resolve('npm', context.env, {
    platform: context.platform,
  })
  if (!npm) return null
  const result = await context.run(npm, ['root', '-g'], {
    cwd: context.neutralDir,
    env: context.env,
    timeoutMs: 15_000,
    maxBuffer: 64_000,
  })
  const raw = result.code === 0 ? result.stdout.trim() : ''
  return raw && isAbsolutePath(raw, context.platform ?? process.platform)
    ? raw
    : null
}

type QueriedGlobalBinManager = CliPackageManager.Yarn | CliPackageManager.Bun

async function queriedGlobalBinDirectory(
  manager: QueriedGlobalBinManager,
  context: PackageManagerContext
): Promise<string | null> {
  const platform = context.platform ?? process.platform
  const definition = MANAGERS[manager]
  const resolve = context.resolve ?? resolveExecutable
  const executablePath = await resolve(definition.binary, context.env, {
    platform,
  })
  if (!executablePath || !isAbsolutePath(executablePath, platform)) return null

  const args =
    manager === CliPackageManager.Yarn ? ['global', 'bin'] : ['pm', 'bin', '-g']
  const result = await context.run(executablePath, args, {
    cwd: context.neutralDir,
    env: context.env,
    timeoutMs: 15_000,
    maxBuffer: 64_000,
  })
  const output = result.code === 0 ? result.stdout.trim() : ''
  if (
    !output ||
    result.timedOut ||
    result.truncated ||
    /[\r\n\0]/.test(output) ||
    !isAbsolutePath(output, platform)
  ) {
    return null
  }
  return output
}

function sameDirectory(
  left: string,
  right: string,
  platform: NodeJS.Platform
): boolean {
  const normalizedLeft = normalizePath(left, platform).replace(/\/+$/, '')
  const normalizedRight = normalizePath(right, platform).replace(/\/+$/, '')
  return normalizedLeft === normalizedRight
}

export async function classifyCliInstall(
  executablePath: string,
  context: PackageManagerContext
): Promise<CliPackageManager> {
  const platform = context.platform ?? process.platform
  const realpathPath = context.realpathPath ?? realpath
  const real = await safeRealpath(executablePath, realpathPath)
  const candidate = normalizePath(real, platform)

  if (
    candidate.includes('/_npx/') ||
    candidate.includes('/.pnpm/_pnpx/') ||
    candidate.includes('/.cache/pnpm/dlx/') ||
    candidate.includes('/.bun/install/cache/')
  ) {
    return CliPackageManager.Unknown
  }
  if (
    candidate.includes('/.volta/') ||
    (platform === 'win32' && candidate.includes('/volta/'))
  ) {
    return CliPackageManager.Volta
  }

  const pnpmHome = context.env.PNPM_HOME
  const normalizedPnpmHome =
    pnpmHome && isAbsolutePath(pnpmHome, platform)
      ? normalizePath(pnpmHome, platform)
      : null
  if (
    (normalizedPnpmHome &&
      candidate.startsWith(withSlash(normalizedPnpmHome))) ||
    candidate.includes('/.local/share/pnpm/') ||
    candidate.includes('/Library/pnpm/') ||
    candidate.includes('/library/pnpm/') ||
    candidate.includes('/appdata/local/pnpm/') ||
    candidate.includes('/.pnpm/global/')
  ) {
    return CliPackageManager.Pnpm
  }
  if (
    candidate.includes('/.config/yarn/global/') ||
    candidate.includes('/.yarn/global/') ||
    candidate.includes('/yarn/data/global/')
  ) {
    return CliPackageManager.Yarn
  }
  if (candidate.includes('/.bun/install/global/')) {
    return CliPackageManager.Bun
  }

  const pathApi = platform === 'win32' ? path.win32 : path
  const candidateDirectory = pathApi.dirname(real)
  const bunInstall = context.env.BUN_INSTALL
  if (
    bunInstall &&
    isAbsolutePath(bunInstall, platform) &&
    sameDirectory(candidateDirectory, pathApi.join(bunInstall, 'bin'), platform)
  ) {
    return CliPackageManager.Bun
  }

  let npmRoot: string | null
  if (platform === 'win32') {
    const [yarnGlobalBin, bunGlobalBin, resolvedNpmRoot] = await Promise.all([
      queriedGlobalBinDirectory(CliPackageManager.Yarn, context),
      queriedGlobalBinDirectory(CliPackageManager.Bun, context),
      npmGlobalRoot(context),
    ])
    if (
      yarnGlobalBin &&
      sameDirectory(candidateDirectory, yarnGlobalBin, platform)
    ) {
      return CliPackageManager.Yarn
    }
    if (
      bunGlobalBin &&
      sameDirectory(candidateDirectory, bunGlobalBin, platform)
    ) {
      return CliPackageManager.Bun
    }
    npmRoot = resolvedNpmRoot
  } else {
    npmRoot = await npmGlobalRoot(context)
  }
  if (npmRoot) {
    const realRoot = await safeRealpath(npmRoot, realpathPath)
    const normalizedRoot = normalizePath(realRoot, platform)
    if (candidate.startsWith(withSlash(normalizedRoot))) {
      return CliPackageManager.Npm
    }
    if (platform === 'win32') {
      const npmPrefix = normalizePath(path.win32.dirname(realRoot), platform)
      if (normalizePath(path.win32.dirname(real), platform) === npmPrefix) {
        return CliPackageManager.Npm
      }
    }
  }
  return CliPackageManager.Unknown
}

export function isCliInstallPackageManager(
  value: unknown
): value is CliInstallPackageManager {
  return (CLI_INSTALL_PACKAGE_MANAGERS as readonly unknown[]).includes(value)
}

export function packageManagerOption(
  manager: CliInstallPackageManager,
  available: boolean
): CliPackageManagerOption {
  const definition = MANAGERS[manager]
  return {
    manager,
    installCommand: [definition.binary, ...definition.args].join(' '),
    available,
  }
}

export function unavailablePackageManagerOptions(): CliPackageManagerOption[] {
  return CLI_INSTALL_PACKAGE_MANAGERS.map((manager) =>
    packageManagerOption(manager, false)
  )
}

export async function resolvePackageManager(
  manager: CliInstallPackageManager,
  context: PackageManagerContext
): Promise<PackageManagerSelection | null> {
  const definition = MANAGERS[manager]
  const resolve = context.resolve ?? resolveExecutable
  const executablePath = await resolve(definition.binary, context.env, {
    platform: context.platform,
  })
  if (!executablePath) return null

  const version = await context.run(executablePath, ['--version'], {
    cwd: context.neutralDir,
    env: context.env,
    timeoutMs: 15_000,
    maxBuffer: 64_000,
  })
  if (version.code !== 0) return null
  if (
    manager === CliPackageManager.Yarn &&
    !/^1\.\d+\.\d+(?:[-+]|$)/.test(version.stdout.trim())
  ) {
    return null
  }

  return {
    manager,
    executablePath,
    args: definition.args,
    command: [definition.binary, ...definition.args].join(' '),
  }
}

export async function discoverPackageManagers(
  context: PackageManagerContext
): Promise<PackageManagerDiscovery> {
  const selections = new Map<
    CliInstallPackageManager,
    PackageManagerSelection
  >()
  const resolved = await Promise.all(
    CLI_INSTALL_PACKAGE_MANAGERS.map((manager) =>
      resolvePackageManager(manager, context)
    )
  )
  for (const [index, manager] of CLI_INSTALL_PACKAGE_MANAGERS.entries()) {
    const selection = resolved[index]
    if (selection) selections.set(manager, selection)
  }

  const markerOrder: Array<readonly [string, CliInstallPackageManager]> = [
    ['VOLTA_HOME', CliPackageManager.Volta],
    ['PNPM_HOME', CliPackageManager.Pnpm],
    ['BUN_INSTALL', CliPackageManager.Bun],
  ]
  let defaultSelection: PackageManagerSelection | null = null
  for (const [marker, manager] of markerOrder) {
    if (context.env[marker]) {
      const selected = selections.get(manager)
      if (selected) {
        defaultSelection = selected
        break
      }
    }
  }

  if (!defaultSelection) {
    const fallbackOrder = [
      CliPackageManager.Npm,
      CliPackageManager.Pnpm,
      CliPackageManager.Volta,
      CliPackageManager.Bun,
      CliPackageManager.Yarn,
    ] as const
    for (const manager of fallbackOrder) {
      const selected = selections.get(manager)
      if (selected) {
        defaultSelection = selected
        break
      }
    }
  }

  return {
    options: CLI_INSTALL_PACKAGE_MANAGERS.map((manager) =>
      packageManagerOption(manager, selections.has(manager))
    ),
    selections,
    defaultSelection,
  }
}

export async function selectPackageManager(
  context: PackageManagerContext
): Promise<PackageManagerSelection | null> {
  return (await discoverPackageManagers(context)).defaultSelection
}

async function managerBinDirectory(
  selection: PackageManagerSelection,
  context: PackageManagerContext
): Promise<string | null> {
  const platform = context.platform ?? process.platform
  const pathApi = platform === 'win32' ? path.win32 : path
  if (selection.manager === CliPackageManager.Volta) {
    const voltaHome = context.env.VOLTA_HOME
    return voltaHome && isAbsolutePath(voltaHome, platform)
      ? pathApi.join(voltaHome, 'bin')
      : pathApi.dirname(selection.executablePath)
  }
  if (selection.manager === CliPackageManager.Bun) {
    const bunInstall = context.env.BUN_INSTALL
    if (bunInstall && isAbsolutePath(bunInstall, platform)) {
      return pathApi.join(bunInstall, 'bin')
    }
  }

  const args =
    selection.manager === CliPackageManager.Npm
      ? ['prefix', '-g']
      : selection.manager === CliPackageManager.Pnpm
        ? ['bin', '-g']
        : selection.manager === CliPackageManager.Yarn
          ? ['global', 'bin']
          : ['pm', 'bin', '-g']
  const result = await context.run(selection.executablePath, args, {
    cwd: context.neutralDir,
    env: context.env,
    timeoutMs: 15_000,
    maxBuffer: 64_000,
  })
  const output = result.code === 0 ? result.stdout.trim() : ''
  if (!output || !isAbsolutePath(output, platform)) return null
  if (selection.manager === CliPackageManager.Npm && platform !== 'win32') {
    return pathApi.join(output, 'bin')
  }
  return output
}

export async function locateManagerCliExecutable(
  selection: PackageManagerSelection,
  context: PackageManagerContext
): Promise<string | null> {
  const directory = await managerBinDirectory(selection, context)
  if (!directory) return null
  const resolve = context.resolve ?? resolveExecutable
  return resolve(
    'motrix',
    {
      PATH: directory,
      PATHEXT: context.env.PATHEXT,
    },
    { platform: context.platform }
  )
}
