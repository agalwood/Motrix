import { CliPackageManager } from '@shared/types/cli-tool'
import { describe, expect, it, vi } from 'vitest'
import type { RunCommand } from './command-runner'
import {
  classifyCliInstall,
  discoverPackageManagers,
  locateManagerCliExecutable,
  type PackageManagerContext,
  selectPackageManager,
} from './package-manager'

function result(stdout = '', code = 0) {
  return { code, stdout, stderr: '' }
}

function context(
  overrides: Partial<PackageManagerContext> = {}
): PackageManagerContext {
  return {
    env: { PATH: '/bin' },
    neutralDir: '/home/user',
    platform: 'linux',
    run: vi.fn().mockResolvedValue(result()),
    resolve: vi.fn().mockResolvedValue(null),
    realpathPath: vi.fn(async (value: string) => value),
    ...overrides,
  }
}

describe('classifyCliInstall', () => {
  it.each([
    [
      '/home/u/.volta/tools/image/packages/@motrix/cli/node_modules/@motrix/cli/dist/bin/motrix.js',
      CliPackageManager.Volta,
    ],
    [
      '/home/u/.local/share/pnpm/global/5/node_modules/@motrix/cli/dist/bin/motrix.js',
      CliPackageManager.Pnpm,
    ],
    [
      '/home/u/.config/yarn/global/node_modules/@motrix/cli/dist/bin/motrix.js',
      CliPackageManager.Yarn,
    ],
    [
      '/home/u/.bun/install/global/node_modules/@motrix/cli/dist/bin/motrix.js',
      CliPackageManager.Bun,
    ],
  ])('classifies %s without probing npm', async (executable, expected) => {
    const run = vi.fn()
    await expect(
      classifyCliInstall(executable, context({ run }))
    ).resolves.toBe(expected)
    expect(run).not.toHaveBeenCalled()
  })

  it('does not treat transient package-manager caches as owners', async () => {
    await expect(
      classifyCliInstall(
        '/home/u/.npm/_npx/x/node_modules/@motrix/cli/dist/bin/motrix.js',
        context()
      )
    ).resolves.toBe(CliPackageManager.Unknown)
  })

  it('does not classify an unrelated lowercase volta directory on POSIX', async () => {
    await expect(
      classifyCliInstall(
        '/srv/volta/project/node_modules/@motrix/cli/dist/bin/motrix.js',
        context()
      )
    ).resolves.toBe(CliPackageManager.Unknown)
  })

  it('uses an absolute npm executable for the last-resort global-root probe', async () => {
    const resolve = vi.fn(async (name: string) =>
      name === 'npm' ? '/usr/local/bin/npm' : null
    )
    const run: RunCommand = vi
      .fn()
      .mockResolvedValue(result('/usr/local/lib/node_modules\n'))
    const realpathPath = vi.fn(async (value: string) =>
      value === '/usr/local/bin/motrix'
        ? '/usr/local/lib/node_modules/@motrix/cli/dist/bin/motrix.js'
        : value
    )

    await expect(
      classifyCliInstall(
        '/usr/local/bin/motrix',
        context({ resolve, run, realpathPath })
      )
    ).resolves.toBe(CliPackageManager.Npm)
    expect(run).toHaveBeenCalledWith(
      '/usr/local/bin/npm',
      ['root', '-g'],
      expect.objectContaining({ cwd: '/home/user' })
    )
  })

  it('classifies a Windows Yarn shim only from the freshly queried exact global bin', async () => {
    const yarn = 'C:\\Program Files\\nodejs\\yarn.cmd'
    const globalBin = 'C:\\Users\\u\\AppData\\Local\\Yarn\\bin'
    const run = vi.fn().mockResolvedValue(result(`${globalBin}\r\n`))
    const resolve = vi.fn(async (name: string) =>
      name === 'yarn' ? yarn : null
    )

    await expect(
      classifyCliInstall(
        `${globalBin}\\motrix.cmd`,
        context({
          env: { PATH: 'C:\\tools' },
          platform: 'win32',
          resolve,
          run,
        })
      )
    ).resolves.toBe(CliPackageManager.Yarn)
    expect(run).toHaveBeenCalledWith(
      yarn,
      ['global', 'bin'],
      expect.objectContaining({ cwd: '/home/user' })
    )
    expect(
      run.mock.calls.filter(([, args]) => args.includes('@motrix/cli@latest'))
    ).toHaveLength(0)
  })

  it('classifies a Windows Bun shim from an absolute BUN_INSTALL bin', async () => {
    const run = vi.fn()

    await expect(
      classifyCliInstall(
        'C:\\Users\\u\\.bun\\bin\\motrix.exe',
        context({
          env: {
            PATH: 'C:\\tools',
            BUN_INSTALL: 'C:\\Users\\u\\.bun',
          },
          platform: 'win32',
          run,
        })
      )
    ).resolves.toBe(CliPackageManager.Bun)
    expect(run).not.toHaveBeenCalled()
  })

  it('classifies a Windows Bun shim only from the freshly queried exact global bin when BUN_INSTALL is absent', async () => {
    const bun = 'C:\\Tools\\Bun\\bun.exe'
    const globalBin = 'C:\\Users\\u\\.bun\\bin'
    const run = vi.fn().mockResolvedValue(result(`${globalBin}\r\n`))
    const resolve = vi.fn(async (name: string) => (name === 'bun' ? bun : null))

    await expect(
      classifyCliInstall(
        `${globalBin}\\motrix.exe`,
        context({
          env: { PATH: 'C:\\tools' },
          platform: 'win32',
          resolve,
          run,
        })
      )
    ).resolves.toBe(CliPackageManager.Bun)
    expect(run).toHaveBeenCalledWith(
      bun,
      ['pm', 'bin', '-g'],
      expect.objectContaining({ cwd: '/home/user' })
    )
    expect(
      run.mock.calls.filter(([, args]) => args.includes('@motrix/cli@latest'))
    ).toHaveLength(0)
  })

  it('does not trust an unrelated Windows .bun bin path', async () => {
    await expect(
      classifyCliInstall(
        'C:\\Temp\\untrusted\\.bun\\bin\\motrix.exe',
        context({
          env: {
            PATH: 'C:\\tools',
            BUN_INSTALL: 'C:\\Users\\u\\.bun',
          },
          platform: 'win32',
        })
      )
    ).resolves.toBe(CliPackageManager.Unknown)
  })
})

describe('selectPackageManager', () => {
  it('reports all options in fixed order while a marker changes only the default', async () => {
    const resolve = vi.fn(async (name: string) =>
      ['npm', 'pnpm', 'bun'].includes(name) ? `/tools/${name}` : null
    )
    const discovery = await discoverPackageManagers(
      context({
        env: { PATH: '/tools', PNPM_HOME: '/tools' },
        resolve,
        run: vi.fn().mockResolvedValue(result('1.0.0\n')),
      })
    )

    expect(discovery.defaultSelection?.manager).toBe(CliPackageManager.Pnpm)
    expect(discovery.options).toEqual([
      {
        manager: CliPackageManager.Npm,
        installCommand: 'npm install -g @motrix/cli@latest',
        available: true,
      },
      {
        manager: CliPackageManager.Pnpm,
        installCommand: 'pnpm add -g @motrix/cli@latest',
        available: true,
      },
      {
        manager: CliPackageManager.Yarn,
        installCommand: 'yarn global add @motrix/cli@latest',
        available: false,
      },
      {
        manager: CliPackageManager.Bun,
        installCommand: 'bun add -g @motrix/cli@latest',
        available: true,
      },
      {
        manager: CliPackageManager.Volta,
        installCommand: 'volta install @motrix/cli@latest',
        available: false,
      },
    ])
  })

  it('probes available managers concurrently', async () => {
    const releases: Array<() => void> = []
    const run = vi.fn(
      () =>
        new Promise<ReturnType<typeof result>>((resolve) => {
          releases.push(() => resolve(result('1.0.0\n')))
        })
    )
    const pending = discoverPackageManagers(
      context({
        resolve: vi.fn(async (name: string) => `/tools/${name}`),
        run,
      })
    )

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(5))
    for (const release of releases) release()
    await expect(pending).resolves.toMatchObject({
      defaultSelection: { manager: CliPackageManager.Npm },
    })
  })

  it('prefers an active pnpm marker over npm', async () => {
    const resolve = vi.fn(async (name: string) => `/tools/${name}`)

    await expect(
      selectPackageManager(
        context({ env: { PATH: '/tools', PNPM_HOME: '/tools' }, resolve })
      )
    ).resolves.toMatchObject({
      manager: CliPackageManager.Pnpm,
      executablePath: '/tools/pnpm',
      args: ['add', '-g', '@motrix/cli@latest'],
      command: 'pnpm add -g @motrix/cli@latest',
    })
  })

  it('uses npm as the canonical fallback', async () => {
    const resolve = vi.fn(async (name: string) =>
      name === 'npm' ? '/tools/npm' : null
    )

    await expect(
      selectPackageManager(context({ resolve }))
    ).resolves.toMatchObject({
      manager: CliPackageManager.Npm,
      command: 'npm install -g @motrix/cli@latest',
    })
  })

  it('accepts Yarn Classic and refuses modern Yarn', async () => {
    const resolve = vi.fn(async (name: string) =>
      name === 'yarn' ? '/tools/yarn' : null
    )
    const classic = vi.fn().mockResolvedValue(result('1.22.22\n'))
    const modern = vi.fn().mockResolvedValue(result('4.9.1\n'))

    await expect(
      selectPackageManager(context({ resolve, run: classic }))
    ).resolves.toMatchObject({ manager: CliPackageManager.Yarn })
    await expect(
      selectPackageManager(context({ resolve, run: modern }))
    ).resolves.toBeNull()
  })

  it('refuses a malformed Yarn version that merely starts with 1', async () => {
    const resolve = vi.fn(async (name: string) =>
      name === 'yarn' ? '/tools/yarn' : null
    )
    const malformed = vi.fn().mockResolvedValue(result('1evil\n'))

    await expect(
      selectPackageManager(context({ resolve, run: malformed }))
    ).resolves.toBeNull()
  })
})

describe('locateManagerCliExecutable', () => {
  it('derives npm global bin without executing a bare command', async () => {
    const run = vi.fn().mockResolvedValue(result('/usr/local\n'))
    const resolve = vi.fn(async (name: string, env: NodeJS.ProcessEnv) =>
      name === 'motrix' && env.PATH === '/usr/local/bin'
        ? '/usr/local/bin/motrix'
        : null
    )

    await expect(
      locateManagerCliExecutable(
        {
          manager: CliPackageManager.Npm,
          executablePath: '/usr/local/bin/npm',
          args: ['install', '-g', '@motrix/cli@latest'],
          command: 'npm install -g @motrix/cli@latest',
        },
        context({ run, resolve })
      )
    ).resolves.toBe('/usr/local/bin/motrix')
    expect(run).toHaveBeenCalledWith(
      '/usr/local/bin/npm',
      ['prefix', '-g'],
      expect.any(Object)
    )
  })
})
