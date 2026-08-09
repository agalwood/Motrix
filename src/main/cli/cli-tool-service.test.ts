import {
  CliInstallCapability,
  type CliInstallPackageManager,
  CliPackageManager,
  CliToolPhase,
  CliToolReason,
} from '@shared/types/cli-tool'
import { describe, expect, it, vi } from 'vitest'
import { CliToolService, sanitizeCliDiagnostic } from './cli-tool-service'
import type { RunCommand, RunResult } from './command-runner'

function completed(stdout = '', overrides: Partial<RunResult> = {}): RunResult {
  return { code: 0, stdout, stderr: '', ...overrides }
}

interface HarnessOptions {
  directInstallSupported?: boolean
  nodeVersion?: string | null
  installedVersion?: string | null
  installedManager?: CliPackageManager
  activeAfterInstallVersion?: string | null
  targetBeforeInstallVersion?: string | null
  targetAfterInstallVersion?: string | null
  installResult?: RunResult
  installWait?: Promise<void>
  initialNodeProbeWait?: Promise<void>
  availableManagers?: CliInstallPackageManager[]
}

function harness(options: HarnessOptions = {}) {
  const env = { PATH: '/tools' }
  let installStarted = false
  let installedWith: CliInstallPackageManager | null = null
  let nodeProbeCount = 0
  const nodeVersion =
    options.nodeVersion === undefined ? '22.18.0' : options.nodeVersion
  const availableManagers = options.availableManagers ?? [CliPackageManager.Npm]
  const managerPaths: Record<CliInstallPackageManager, string> = {
    [CliPackageManager.Npm]: '/tools/npm',
    [CliPackageManager.Pnpm]: '/tools/pnpm',
    [CliPackageManager.Yarn]: '/tools/yarn',
    [CliPackageManager.Bun]: '/tools/bun',
    [CliPackageManager.Volta]: '/global/bin/volta',
  }
  const resolve = vi.fn(
    async (name: string, requestedEnv: NodeJS.ProcessEnv) => {
      if (name === 'node') return nodeVersion ? '/tools/node' : null
      const manager = availableManagers.find((candidate) => candidate === name)
      if (manager) return managerPaths[manager]
      if (name !== 'motrix') return null
      if (requestedEnv.PATH === '/global/bin') {
        const targetVersion = installStarted
          ? (options.targetAfterInstallVersion ??
            options.targetBeforeInstallVersion)
          : options.targetBeforeInstallVersion
        return targetVersion ? '/global/bin/motrix' : null
      }
      if (!installStarted && options.installedVersion) {
        return '/tools/motrix'
      }
      if (installStarted && options.activeAfterInstallVersion) {
        return options.activeAfterInstallVersion ===
          options.targetAfterInstallVersion
          ? '/global/bin/motrix'
          : '/old/bin/motrix'
      }
      return null
    }
  )
  const run: RunCommand = vi.fn(async (command, args) => {
    if (command === '/tools/node') {
      ++nodeProbeCount
      if (nodeProbeCount === 1) await options.initialNodeProbeWait
      return completed(`v${nodeVersion}\n`)
    }
    const commandManager = availableManagers.find(
      (manager) => managerPaths[manager] === command
    )
    if (commandManager && args[0] === '--version') {
      return completed(
        commandManager === CliPackageManager.Yarn ? '1.22.22\n' : '11.6.0\n'
      )
    }
    const isInstall =
      commandManager === CliPackageManager.Npm
        ? args[0] === 'install'
        : commandManager === CliPackageManager.Pnpm
          ? args[0] === 'add'
          : commandManager === CliPackageManager.Yarn
            ? args[0] === 'global' && args[1] === 'add'
            : commandManager === CliPackageManager.Bun
              ? args[0] === 'add'
              : commandManager === CliPackageManager.Volta
                ? args[0] === 'install'
                : false
    if (commandManager && isInstall) {
      installStarted = true
      installedWith = commandManager
      await options.installWait
      return options.installResult ?? completed('installed\n')
    }
    if (command === '/tools/npm' && args[0] === 'prefix') {
      return completed('/global\n')
    }
    if (command === '/tools/npm' && args[0] === 'root') {
      return completed('/global/lib/node_modules\n')
    }
    if (command === '/tools/pnpm' && args[0] === 'bin') {
      return completed('/global/bin\n')
    }
    if (command === '/tools/yarn' && args[0] === 'global') {
      return completed('/global/bin\n')
    }
    if (command === '/tools/bun' && args[0] === 'pm') {
      return completed('/global/bin\n')
    }
    if (command === '/tools/motrix') {
      return completed(`${options.installedVersion}\n`)
    }
    if (command === '/global/bin/motrix') {
      const version = installStarted
        ? (options.targetAfterInstallVersion ??
          options.targetBeforeInstallVersion)
        : options.targetBeforeInstallVersion
      return completed(`${version}\n`)
    }
    if (command === '/old/bin/motrix') {
      return completed(`${options.activeAfterInstallVersion}\n`)
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
  })
  const realpathPath = vi.fn(async (value: string) => {
    if (value === '/tools/motrix' || value === '/global/bin/motrix') {
      const owner = installedWith ?? options.installedManager
      if (owner === CliPackageManager.Pnpm) {
        return '/home/user/.local/share/pnpm/global/5/node_modules/@motrix/cli/dist/bin/motrix.js'
      }
      if (owner === CliPackageManager.Yarn) {
        return '/home/user/.config/yarn/global/node_modules/@motrix/cli/dist/bin/motrix.js'
      }
      if (owner === CliPackageManager.Bun) {
        return '/home/user/.bun/install/global/node_modules/@motrix/cli/dist/bin/motrix.js'
      }
      if (owner === CliPackageManager.Volta) {
        return '/home/user/.volta/tools/image/packages/@motrix/cli/node_modules/@motrix/cli/dist/bin/motrix.js'
      }
      if (owner === CliPackageManager.Unknown) {
        return '/opt/external/motrix.js'
      }
      return '/global/lib/node_modules/@motrix/cli/dist/bin/motrix.js'
    }
    return value
  })
  const environment = {
    resolve: vi.fn(async () => ({ ...env })),
  }
  const service = new CliToolService({
    directInstallSupported: options.directInstallSupported ?? true,
    platform: 'linux',
    environment,
    run,
    resolve,
    realpathPath,
    neutralDir: '/home/user',
  })
  return { service, run: vi.mocked(run), resolve, environment }
}

describe('CliToolService status', () => {
  it('reports an existing installation without overwriting it', async () => {
    const { service, run } = harness({ installedVersion: '0.4.0' })

    await expect(service.getStatus()).resolves.toMatchObject({
      phase: CliToolPhase.Installed,
      packageManager: CliPackageManager.Npm,
      version: '0.4.0',
      executablePath: '/global/lib/node_modules/@motrix/cli/dist/bin/motrix.js',
      nodeVersion: '22.18.0',
    })
    expect(
      run.mock.calls.filter(([, args]) => args[0] === 'install')
    ).toHaveLength(0)
  })

  it('selects npm and returns its exact fixed command', async () => {
    const { service } = harness()
    await expect(service.getStatus()).resolves.toMatchObject({
      phase: CliToolPhase.Ready,
      capability: CliInstallCapability.Direct,
      packageManager: CliPackageManager.Npm,
      installCommand: 'npm install -g @motrix/cli@latest',
      nodeVersion: '22.18.0',
    })
  })

  it('returns all fixed manager options with deterministic availability', async () => {
    const { service } = harness({
      availableManagers: [CliPackageManager.Npm, CliPackageManager.Bun],
    })
    const status = await service.getStatus()

    expect(
      status.managerOptions.map(({ manager, available }) => [
        manager,
        available,
      ])
    ).toEqual([
      [CliPackageManager.Npm, true],
      [CliPackageManager.Pnpm, false],
      [CliPackageManager.Yarn, false],
      [CliPackageManager.Bun, true],
      [CliPackageManager.Volta, false],
    ])
  })

  it.each<[string | null, CliToolReason]>([
    [null, CliToolReason.NodeMissing],
    ['20.19.0', CliToolReason.NodeTooOld],
  ])('requires Node.js 22 or newer (%s)', async (nodeVersion, reason) => {
    const { service } = harness({ nodeVersion })
    await expect(service.getStatus()).resolves.toMatchObject({
      phase: CliToolPhase.NeedsAttention,
      capability: CliInstallCapability.ManualOnly,
      reason,
    })
  })

  it.each<[string | null, CliToolReason]>([
    [null, CliToolReason.NodeMissing],
    ['20.19.0', CliToolReason.NodeTooOld],
  ])(
    'does not report an existing CLI as installed when Node.js is unsupported (%s)',
    async (nodeVersion, reason) => {
      const { service, run } = harness({
        installedVersion: '0.4.0',
        nodeVersion,
      })

      const status = await service.getStatus()
      expect(status).toMatchObject({
        phase: CliToolPhase.NeedsAttention,
        reason,
        executablePath: '/tools/motrix',
      })
      expect(status.phase).not.toBe(CliToolPhase.Installed)
      expect(
        run.mock.calls.filter(([, args]) => args.includes('@motrix/cli@latest'))
      ).toHaveLength(0)
    }
  )

  it('is manual-only in a sandbox even when host tools are absent', async () => {
    const { service, run } = harness({
      directInstallSupported: false,
      nodeVersion: null,
    })
    await expect(service.getStatus()).resolves.toMatchObject({
      phase: CliToolPhase.ManualOnly,
      capability: CliInstallCapability.ManualOnly,
      reason: CliToolReason.Sandboxed,
      installCommand: 'npm install -g @motrix/cli@latest',
    })
    expect(
      run.mock.calls.filter(([, args]) => args[0] === 'install')
    ).toHaveLength(0)
  })
})

describe('CliToolService installation', () => {
  it.each<[CliInstallPackageManager, string, string[], string]>([
    [
      CliPackageManager.Npm,
      '/tools/npm',
      ['install', '-g', '@motrix/cli@latest'],
      'npm install -g @motrix/cli@latest',
    ],
    [
      CliPackageManager.Pnpm,
      '/tools/pnpm',
      ['add', '-g', '@motrix/cli@latest'],
      'pnpm add -g @motrix/cli@latest',
    ],
    [
      CliPackageManager.Yarn,
      '/tools/yarn',
      ['global', 'add', '@motrix/cli@latest'],
      'yarn global add @motrix/cli@latest',
    ],
    [
      CliPackageManager.Bun,
      '/tools/bun',
      ['add', '-g', '@motrix/cli@latest'],
      'bun add -g @motrix/cli@latest',
    ],
    [
      CliPackageManager.Volta,
      '/global/bin/volta',
      ['install', '@motrix/cli@latest'],
      'volta install @motrix/cli@latest',
    ],
  ])(
    'executes the explicitly selected %s manager',
    async (manager, executable, args, installCommand) => {
      const { service, run } = harness({
        availableManagers: [
          CliPackageManager.Npm,
          CliPackageManager.Pnpm,
          CliPackageManager.Yarn,
          CliPackageManager.Bun,
          CliPackageManager.Volta,
        ],
        activeAfterInstallVersion: '0.4.0',
        targetAfterInstallVersion: '0.4.0',
      })

      await expect(
        service.install({ packageManager: manager })
      ).resolves.toMatchObject({
        phase: CliToolPhase.Installed,
        packageManager: manager,
        installCommand,
      })
      expect(run).toHaveBeenCalledWith(
        executable,
        args,
        expect.objectContaining({ timeoutMs: 300_000 })
      )
    }
  )

  it('refuses an unavailable selected manager before installer spawn', async () => {
    const { service, run } = harness()

    await expect(
      service.install({ packageManager: CliPackageManager.Pnpm })
    ).resolves.toMatchObject({
      phase: CliToolPhase.NeedsAttention,
      packageManager: CliPackageManager.Pnpm,
      reason: CliToolReason.ManagerMissing,
    })
    expect(
      run.mock.calls.filter(([, args]) => args.includes('@motrix/cli@latest'))
    ).toHaveLength(0)
  })

  it('runtime-rejects a forged manager before any process probe', async () => {
    const { service, run } = harness()

    await expect(
      service.install({ packageManager: 'forged' } as never)
    ).resolves.toMatchObject({
      phase: CliToolPhase.Error,
      reason: CliToolReason.Unknown,
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('freshly refuses a manager that disappeared after status discovery', async () => {
    const availableManagers: CliInstallPackageManager[] = [
      CliPackageManager.Pnpm,
    ]
    const { service, run } = harness({ availableManagers })
    await expect(service.getStatus()).resolves.toMatchObject({
      phase: CliToolPhase.Ready,
      packageManager: CliPackageManager.Pnpm,
    })
    availableManagers.length = 0

    await expect(
      service.install({ packageManager: CliPackageManager.Pnpm })
    ).resolves.toMatchObject({
      phase: CliToolPhase.ManualOnly,
      reason: CliToolReason.ManagerMissing,
    })
    expect(
      run.mock.calls.filter(([, args]) => args.includes('@motrix/cli@latest'))
    ).toHaveLength(0)
  })

  it.each([
    [CliPackageManager.Pnpm, 'pnpm add -g @motrix/cli@latest'],
    [CliPackageManager.Volta, 'volta install @motrix/cli@latest'],
  ])(
    'uses the classified %s owner command when fresh preflight finds an external install',
    async (installedManager, installCommand) => {
      const options: HarnessOptions = {
        availableManagers: [CliPackageManager.Npm],
        installedManager,
      }
      const { service, run } = harness(options)
      await expect(service.getStatus()).resolves.toMatchObject({
        phase: CliToolPhase.Ready,
        packageManager: CliPackageManager.Npm,
      })
      options.installedVersion = '0.4.0'

      await expect(
        service.install({ packageManager: CliPackageManager.Npm })
      ).resolves.toMatchObject({
        phase: CliToolPhase.Installed,
        packageManager: installedManager,
        installCommand,
        version: '0.4.0',
      })
      expect(
        run.mock.calls.filter(([, args]) => args.includes('@motrix/cli@latest'))
      ).toHaveLength(0)
    }
  )

  it('keeps the requested command when fresh preflight finds an external install with unknown ownership', async () => {
    const options: HarnessOptions = {
      availableManagers: [CliPackageManager.Bun],
      installedManager: CliPackageManager.Unknown,
    }
    const { service, run } = harness(options)
    await expect(service.getStatus()).resolves.toMatchObject({
      phase: CliToolPhase.Ready,
      packageManager: CliPackageManager.Bun,
    })
    options.installedVersion = '0.4.0'

    await expect(
      service.install({ packageManager: CliPackageManager.Bun })
    ).resolves.toMatchObject({
      phase: CliToolPhase.Installed,
      packageManager: CliPackageManager.Unknown,
      installCommand: 'bun add -g @motrix/cli@latest',
      version: '0.4.0',
    })
    expect(
      run.mock.calls.filter(([, args]) => args.includes('@motrix/cli@latest'))
    ).toHaveLength(0)
  })

  it('refuses manual-only mutations before installer spawn', async () => {
    const { service, run } = harness({ directInstallSupported: false })

    await expect(
      service.install({ packageManager: CliPackageManager.Npm })
    ).resolves.toMatchObject({
      phase: CliToolPhase.ManualOnly,
      reason: CliToolReason.Sandboxed,
    })
    expect(
      run.mock.calls.filter(([, args]) => args.includes('@motrix/cli@latest'))
    ).toHaveLength(0)
  })

  it('installs once and verifies the active PATH binary', async () => {
    const { service, run, environment } = harness({
      activeAfterInstallVersion: '0.4.0',
      targetAfterInstallVersion: '0.4.0',
    })

    await expect(
      service.install({ packageManager: CliPackageManager.Npm })
    ).resolves.toMatchObject({
      phase: CliToolPhase.Installed,
      packageManager: CliPackageManager.Npm,
      version: '0.4.0',
    })
    expect(run).toHaveBeenCalledWith(
      '/tools/npm',
      ['install', '-g', '@motrix/cli@latest'],
      expect.objectContaining({
        cwd: '/home/user',
        timeoutMs: 300_000,
      })
    )
    expect(environment.resolve).toHaveBeenLastCalledWith(true)
  })

  it('shares one in-flight Promise and exposes Installing to queries', async () => {
    let release!: () => void
    const installWait = new Promise<void>((resolve) => {
      release = resolve
    })
    const { service, run } = harness({
      activeAfterInstallVersion: '0.4.0',
      targetAfterInstallVersion: '0.4.0',
      installWait,
    })

    const first = service.install({ packageManager: CliPackageManager.Npm })
    const second = service.install({ packageManager: CliPackageManager.Npm })
    expect(second).toBe(first)
    await vi.waitFor(() =>
      expect(
        run.mock.calls.filter(([, args]) => args[0] === 'install')
      ).toHaveLength(1)
    )
    await expect(service.getStatus()).resolves.toMatchObject({
      phase: CliToolPhase.Installing,
    })

    release()
    await expect(first).resolves.toMatchObject({
      phase: CliToolPhase.Installed,
    })
  })

  it('keeps the first manager authoritative when a different manager joins the install flight', async () => {
    let release!: () => void
    const installWait = new Promise<void>((resolve) => {
      release = resolve
    })
    const { service, run } = harness({
      availableManagers: [CliPackageManager.Npm, CliPackageManager.Pnpm],
      activeAfterInstallVersion: '0.4.0',
      targetAfterInstallVersion: '0.4.0',
      installWait,
    })

    const first = service.install({ packageManager: CliPackageManager.Npm })
    const second = service.install({ packageManager: CliPackageManager.Pnpm })
    expect(second).toBe(first)
    await vi.waitFor(() =>
      expect(
        run.mock.calls.filter(
          ([command, args]) => command === '/tools/npm' && args[0] === 'install'
        )
      ).toHaveLength(1)
    )
    await expect(service.getStatus()).resolves.toMatchObject({
      phase: CliToolPhase.Installing,
      packageManager: CliPackageManager.Npm,
      installCommand: 'npm install -g @motrix/cli@latest',
    })
    expect(
      run.mock.calls.filter(
        ([command, args]) => command === '/tools/pnpm' && args[0] === 'add'
      )
    ).toHaveLength(0)

    release()
    await expect(first).resolves.toMatchObject({
      phase: CliToolPhase.Installed,
      packageManager: CliPackageManager.Npm,
      installCommand: 'npm install -g @motrix/cli@latest',
    })
    await expect(second).resolves.toMatchObject({
      phase: CliToolPhase.Installed,
      packageManager: CliPackageManager.Npm,
      installCommand: 'npm install -g @motrix/cli@latest',
    })
    expect(
      run.mock.calls.filter(([, args]) => args.includes('@motrix/cli@latest'))
    ).toHaveLength(1)
  })

  it('publishes the requested manager in the immediate Installing snapshot', async () => {
    let releaseProbe!: () => void
    const initialNodeProbeWait = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    const { service } = harness({
      availableManagers: [CliPackageManager.Npm, CliPackageManager.Pnpm],
      activeAfterInstallVersion: '0.4.0',
      targetAfterInstallVersion: '0.4.0',
      initialNodeProbeWait,
    })

    const pending = service.install({ packageManager: CliPackageManager.Pnpm })
    await expect(service.getStatus()).resolves.toMatchObject({
      phase: CliToolPhase.Installing,
      packageManager: CliPackageManager.Pnpm,
      installCommand: 'pnpm add -g @motrix/cli@latest',
      managerOptions: expect.any(Array),
    })

    releaseProbe()
    await expect(pending).resolves.toMatchObject({
      phase: CliToolPhase.Installed,
      packageManager: CliPackageManager.Pnpm,
    })
  })

  it('preserves the selected manager while install preflight begins', async () => {
    let release!: () => void
    const installWait = new Promise<void>((resolve) => {
      release = resolve
    })
    const { service } = harness({
      activeAfterInstallVersion: '0.4.0',
      targetAfterInstallVersion: '0.4.0',
      installWait,
    })
    await expect(service.getStatus()).resolves.toMatchObject({
      phase: CliToolPhase.Ready,
      packageManager: CliPackageManager.Npm,
    })

    const pending = service.install({ packageManager: CliPackageManager.Npm })
    await expect(service.getStatus()).resolves.toMatchObject({
      phase: CliToolPhase.Installing,
      packageManager: CliPackageManager.Npm,
      installCommand: 'npm install -g @motrix/cli@latest',
    })

    release()
    await expect(pending).resolves.toMatchObject({
      phase: CliToolPhase.Installed,
    })
  })

  it('does not let an older status probe overwrite a completed install', async () => {
    let releaseProbe!: () => void
    const initialNodeProbeWait = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    const { service, run } = harness({
      activeAfterInstallVersion: '0.4.0',
      targetAfterInstallVersion: '0.4.0',
      initialNodeProbeWait,
    })

    const staleStatus = service.getStatus()
    await vi.waitFor(() =>
      expect(
        run.mock.calls.filter(([command]) => command === '/tools/node')
      ).toHaveLength(1)
    )
    await expect(
      service.install({ packageManager: CliPackageManager.Npm })
    ).resolves.toMatchObject({
      phase: CliToolPhase.Installed,
      version: '0.4.0',
    })

    releaseProbe()
    await expect(staleStatus).resolves.toMatchObject({
      phase: CliToolPhase.Installed,
      version: '0.4.0',
    })
  })

  it('reports a verified install that is missing from PATH', async () => {
    const { service } = harness({ targetAfterInstallVersion: '0.4.0' })

    await expect(
      service.install({ packageManager: CliPackageManager.Npm })
    ).resolves.toMatchObject({
      phase: CliToolPhase.NeedsAttention,
      reason: CliToolReason.PathMissing,
      version: '0.4.0',
      executablePath: '/global/bin/motrix',
    })
  })

  it('detects an older active binary shadowing the installed target', async () => {
    const { service } = harness({
      activeAfterInstallVersion: '0.1.0',
      targetAfterInstallVersion: '0.4.0',
    })

    await expect(
      service.install({ packageManager: CliPackageManager.Npm })
    ).resolves.toMatchObject({
      phase: CliToolPhase.NeedsAttention,
      reason: CliToolReason.PathShadowed,
      version: '0.1.0',
      executablePath: '/old/bin/motrix',
    })
  })

  it.each([
    [
      completed('', { code: 1, stderr: 'npm ERR! EACCES' }),
      CliToolReason.Permission,
    ],
    [
      completed('', { code: 1, stderr: 'npm ERR! ENOTFOUND registry' }),
      CliToolReason.Network,
    ],
    [completed('', { code: null, timedOut: true }), CliToolReason.Timeout],
  ])('maps installer failure to %s', async (installResult, reason) => {
    const { service } = harness({ installResult })
    await expect(
      service.install({ packageManager: CliPackageManager.Npm })
    ).resolves.toMatchObject({
      phase: CliToolPhase.Error,
      reason,
    })
  })

  it('does not mistake an unchanged pre-existing target for a successful install', async () => {
    const { service } = harness({
      targetBeforeInstallVersion: '0.3.0',
      installResult: completed('', {
        code: 1,
        stderr: 'npm ERR! EACCES',
      }),
    })

    await expect(
      service.install({ packageManager: CliPackageManager.Npm })
    ).resolves.toMatchObject({
      phase: CliToolPhase.Error,
      reason: CliToolReason.Permission,
      version: null,
    })
  })

  it('redacts credentials and the home directory from diagnostics', async () => {
    const { service } = harness({
      installResult: completed('', {
        code: 1,
        stderr:
          'EACCES /home/user/.npmrc _authToken=secret-123 Authorization: Bearer abc.def',
      }),
    })
    const status = await service.install({
      packageManager: CliPackageManager.Npm,
    })
    expect(status.detail).not.toContain('secret-123')
    expect(status.detail).not.toContain('abc.def')
    expect(status.detail).not.toContain('/home/user')
    expect(status.detail).toContain('[redacted]')
  })
})

describe('sanitizeCliDiagnostic', () => {
  it('redacts quoted credentials, npm _auth, and Windows home separator variants', () => {
    const diagnostic = sanitizeCliDiagnostic(
      '{"token":"hunter2"} _auth=YWJj C:/Users/Me/file',
      'C:\\Users\\Me',
      'win32'
    )

    expect(diagnostic).not.toContain('hunter2')
    expect(diagnostic).not.toContain('YWJj')
    expect(diagnostic).not.toContain('C:/Users/Me')
    expect(diagnostic).toContain('[redacted]')
    expect(diagnostic).toContain('~/file')
  })

  it('retains only the bounded sanitized tail', () => {
    const diagnostic = sanitizeCliDiagnostic(
      `${'x'.repeat(20_000)} token=hunter2 C:\\Users\\Me\\file`,
      'C:\\Users\\Me',
      'win32'
    )
    expect(diagnostic.length).toBeLessThanOrEqual(12_000)
    expect(diagnostic).not.toContain('hunter2')
    expect(diagnostic).not.toContain('C:\\Users\\Me')
  })
})
