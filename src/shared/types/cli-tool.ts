export enum CliToolPhase {
  Checking = 'checking',
  Ready = 'ready',
  Installing = 'installing',
  Installed = 'installed',
  NeedsAttention = 'needs-attention',
  ManualOnly = 'manual-only',
  Error = 'error',
}

export enum CliInstallCapability {
  Direct = 'direct',
  ManualOnly = 'manual-only',
}

export enum CliPackageManager {
  Npm = 'npm',
  Pnpm = 'pnpm',
  Yarn = 'yarn',
  Bun = 'bun',
  Volta = 'volta',
  Unknown = 'unknown',
}

export enum CliToolReason {
  NodeMissing = 'node-missing',
  NodeTooOld = 'node-too-old',
  ManagerMissing = 'manager-missing',
  Sandboxed = 'sandboxed',
  UnsupportedWeb = 'unsupported-web',
  Permission = 'permission',
  Network = 'network',
  Timeout = 'timeout',
  PathMissing = 'path-missing',
  PathShadowed = 'path-shadowed',
  VerifyFailed = 'verify-failed',
  InstallFailed = 'install-failed',
  Unknown = 'unknown',
}

export const CLI_INSTALL_PACKAGE_MANAGERS = [
  CliPackageManager.Npm,
  CliPackageManager.Pnpm,
  CliPackageManager.Yarn,
  CliPackageManager.Bun,
  CliPackageManager.Volta,
] as const

export type CliInstallPackageManager =
  (typeof CLI_INSTALL_PACKAGE_MANAGERS)[number]

export interface CliPackageManagerOption {
  manager: CliInstallPackageManager
  installCommand: string
  available: boolean
}

export interface CliInstallRequest {
  packageManager: CliInstallPackageManager
}

export interface CliToolStatus {
  phase: CliToolPhase
  capability: CliInstallCapability
  installCommand: string
  packageManager: CliPackageManager
  managerOptions: CliPackageManagerOption[]
  version: string | null
  executablePath: string | null
  nodeVersion: string | null
  reason: CliToolReason | null
  detail: string | null
}
