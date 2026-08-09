import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  CliInstallCapability,
  CliPackageManager,
  type CliPackageManagerOption,
  CliToolPhase,
  CliToolReason,
  type CliToolStatus,
} from '@shared/types/cli-tool'
import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCliTool } from './use-cli-tool'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn() },
}))

const MANAGER_OPTIONS: CliPackageManagerOption[] = [
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
]

const READY_STATUS: CliToolStatus = {
  phase: CliToolPhase.Ready,
  capability: CliInstallCapability.Direct,
  installCommand: 'pnpm add -g @motrix/cli@latest',
  packageManager: CliPackageManager.Pnpm,
  managerOptions: MANAGER_OPTIONS,
  version: null,
  executablePath: null,
  nodeVersion: 'v22.18.0',
  reason: null,
  detail: null,
}

const INSTALLED_STATUS: CliToolStatus = {
  ...READY_STATUS,
  phase: CliToolPhase.Installed,
  version: '0.4.0',
  executablePath: '/Users/example/.local/bin/motrix',
}

describe('useCliTool', () => {
  beforeEach(() => {
    vi.mocked(transport.invoke).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('adopts the initial Ready marker default over the npm checking fallback', async () => {
    vi.mocked(transport.invoke).mockResolvedValue(READY_STATUS)

    const { result } = renderHook(() => useCliTool())

    expect(result.current.status.phase).toBe(CliToolPhase.Checking)
    expect(result.current.isRefreshing).toBe(false)
    await waitFor(() => expect(result.current.status).toEqual(READY_STATUS))
    expect(result.current.selectedManager).toBe(CliPackageManager.Pnpm)
    expect(result.current.selectedCommand).toBe(
      'pnpm add -g @motrix/cli@latest'
    )
    expect(transport.invoke).toHaveBeenCalledWith(Queries.GetCliToolStatus)
  })

  it('starts a fresh status query during StrictMode effect replay', async () => {
    let queryCount = 0
    let resolveFirst: (status: CliToolStatus) => void = () => {}
    vi.mocked(transport.invoke).mockImplementation(() => {
      queryCount += 1
      if (queryCount === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve
        })
      }
      return Promise.resolve(READY_STATUS)
    })

    const { result } = renderHook(() => useCliTool(), {
      wrapper: StrictMode,
    })

    await waitFor(() => expect(queryCount).toBe(2))
    await waitFor(() => expect(result.current.status).toEqual(READY_STATUS))

    await act(async () => {
      resolveFirst(INSTALLED_STATUS)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.status).toEqual(READY_STATUS)
  })

  it('adopts refreshed backend defaults until the user selects a manager', async () => {
    const refreshedStatus: CliToolStatus = {
      ...READY_STATUS,
      installCommand: 'npm install -g @motrix/cli@latest',
      packageManager: CliPackageManager.Npm,
    }
    vi.mocked(transport.invoke)
      .mockResolvedValueOnce(READY_STATUS)
      .mockResolvedValueOnce(refreshedStatus)

    const { result } = renderHook(() => useCliTool())
    await waitFor(() => expect(result.current.status).toEqual(READY_STATUS))
    await act(async () => result.current.refresh())

    expect(result.current.selectedManager).toBe(CliPackageManager.Npm)
    expect(result.current.selectedCommand).toBe(
      'npm install -g @motrix/cli@latest'
    )
  })

  it('preserves an explicit manager selection across a compatible refresh', async () => {
    const refreshedStatus: CliToolStatus = {
      ...READY_STATUS,
      installCommand: 'npm install -g @motrix/cli@latest',
      packageManager: CliPackageManager.Npm,
    }
    vi.mocked(transport.invoke)
      .mockResolvedValueOnce(READY_STATUS)
      .mockResolvedValueOnce(refreshedStatus)

    const { result } = renderHook(() => useCliTool())
    await waitFor(() => expect(result.current.status).toEqual(READY_STATUS))

    act(() => result.current.selectManager(CliPackageManager.Bun))
    await act(async () => result.current.refresh())

    expect(result.current.status).toEqual(refreshedStatus)
    expect(result.current.selectedManager).toBe(CliPackageManager.Bun)
    expect(result.current.selectedCommand).toBe('bun add -g @motrix/cli@latest')
  })

  it('falls back when an explicit manager becomes unavailable for direct install', async () => {
    const refreshedStatus: CliToolStatus = {
      ...READY_STATUS,
      managerOptions: MANAGER_OPTIONS.map((option) => ({
        ...option,
        available:
          option.manager === CliPackageManager.Bun ? false : option.available,
      })),
    }
    vi.mocked(transport.invoke)
      .mockResolvedValueOnce(READY_STATUS)
      .mockResolvedValueOnce(refreshedStatus)

    const { result } = renderHook(() => useCliTool())
    await waitFor(() => expect(result.current.status).toEqual(READY_STATUS))

    act(() => result.current.selectManager(CliPackageManager.Bun))
    await act(async () => result.current.refresh())

    expect(result.current.selectedManager).toBe(CliPackageManager.Pnpm)
    expect(result.current.selectedCommand).toBe(
      'pnpm add -g @motrix/cli@latest'
    )
  })

  it('preserves any explicit fixed command on a manual-only surface', async () => {
    const manualStatus: CliToolStatus = {
      ...READY_STATUS,
      phase: CliToolPhase.ManualOnly,
      capability: CliInstallCapability.ManualOnly,
      installCommand: 'npm install -g @motrix/cli@latest',
      packageManager: CliPackageManager.Npm,
      managerOptions: MANAGER_OPTIONS.map((option) => ({
        ...option,
        available: false,
      })),
    }
    vi.mocked(transport.invoke).mockResolvedValue(manualStatus)

    const { result } = renderHook(() => useCliTool())
    await waitFor(() => expect(result.current.status).toEqual(manualStatus))

    act(() => result.current.selectManager(CliPackageManager.Volta))
    await act(async () => result.current.refresh())

    expect(result.current.selectedManager).toBe(CliPackageManager.Volta)
    expect(result.current.selectedCommand).toBe(
      'volta install @motrix/cli@latest'
    )
  })

  it('preserves a failed requested manager through refresh and retry', async () => {
    const failedBunStatus: CliToolStatus = {
      ...READY_STATUS,
      phase: CliToolPhase.Error,
      installCommand: 'bun add -g @motrix/cli@latest',
      packageManager: CliPackageManager.Npm,
      reason: CliToolReason.InstallFailed,
    }
    const refreshedNpmStatus: CliToolStatus = {
      ...READY_STATUS,
      installCommand: 'npm install -g @motrix/cli@latest',
      packageManager: CliPackageManager.Npm,
    }
    let queryCount = 0
    vi.mocked(transport.invoke).mockImplementation((channel) => {
      if (channel === Queries.GetCliToolStatus) {
        queryCount += 1
        return Promise.resolve(
          queryCount === 1 ? READY_STATUS : refreshedNpmStatus
        )
      }
      return Promise.resolve(failedBunStatus)
    })

    const { result } = renderHook(() => useCliTool())
    await waitFor(() => expect(result.current.status).toEqual(READY_STATUS))
    act(() => result.current.selectManager(CliPackageManager.Bun))

    await act(async () => result.current.install())
    expect(result.current.status).toEqual(failedBunStatus)
    expect(result.current.selectedManager).toBe(CliPackageManager.Bun)
    expect(result.current.selectedCommand).toBe('bun add -g @motrix/cli@latest')

    await act(async () => result.current.refresh())
    expect(result.current.status).toEqual(refreshedNpmStatus)
    expect(result.current.selectedManager).toBe(CliPackageManager.Bun)
    expect(result.current.selectedCommand).toBe('bun add -g @motrix/cli@latest')

    await act(async () => result.current.install())
    expect(
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(([channel]) => channel === Commands.InstallCliTool)
    ).toEqual([
      [Commands.InstallCliTool, { packageManager: CliPackageManager.Bun }],
      [Commands.InstallCliTool, { packageManager: CliPackageManager.Bun }],
    ])
  })

  it('installs once and clears explicit intent when terminal adopts another manager', async () => {
    const terminalStatus: CliToolStatus = {
      ...INSTALLED_STATUS,
      installCommand: 'npm install -g @motrix/cli@latest',
      packageManager: CliPackageManager.Npm,
    }
    let resolveInstall: (status: CliToolStatus) => void = () => {}
    vi.mocked(transport.invoke).mockImplementation((channel) => {
      if (channel === Queries.GetCliToolStatus) {
        return Promise.resolve(READY_STATUS)
      }
      return new Promise((resolve) => {
        resolveInstall = resolve
      })
    })
    const { result } = renderHook(() => useCliTool())
    await waitFor(() => expect(result.current.status).toEqual(READY_STATUS))

    act(() => result.current.selectManager(CliPackageManager.Bun))
    expect(result.current.selectedManager).toBe(CliPackageManager.Bun)
    expect(result.current.selectedCommand).toBe('bun add -g @motrix/cli@latest')

    let first: Promise<void>
    let second: Promise<void>
    act(() => {
      first = result.current.install()
      second = result.current.install()
    })
    expect(first!).toBe(second!)
    expect(result.current.status.phase).toBe(CliToolPhase.Installing)
    expect(
      vi
        .mocked(transport.invoke)
        .mock.calls.filter(([channel]) => channel === Commands.InstallCliTool)
    ).toHaveLength(1)
    expect(transport.invoke).toHaveBeenCalledWith(Commands.InstallCliTool, {
      packageManager: CliPackageManager.Bun,
    })

    await act(async () => {
      resolveInstall(terminalStatus)
      await first!
    })
    expect(result.current.status).toEqual(terminalStatus)
    expect(result.current.selectedManager).toBe(CliPackageManager.Npm)
    expect(result.current.selectedCommand).toBe(
      'npm install -g @motrix/cli@latest'
    )

    await act(async () => result.current.refresh())
    expect(result.current.selectedManager).toBe(CliPackageManager.Pnpm)
    expect(result.current.selectedCommand).toBe(
      'pnpm add -g @motrix/cli@latest'
    )
  })

  it('exposes interactive refresh feedback and shares duplicate calls', async () => {
    let queryCount = 0
    let resolveRefresh: (status: CliToolStatus) => void = () => {}
    vi.mocked(transport.invoke).mockImplementation((channel) => {
      if (channel !== Queries.GetCliToolStatus) {
        return Promise.resolve(INSTALLED_STATUS)
      }
      queryCount += 1
      if (queryCount === 1) return Promise.resolve(READY_STATUS)
      return new Promise((resolve) => {
        resolveRefresh = resolve
      })
    })
    const { result } = renderHook(() => useCliTool())
    await waitFor(() => expect(result.current.status).toEqual(READY_STATUS))

    let first: Promise<void>
    let second: Promise<void>
    act(() => {
      first = result.current.refresh()
      second = result.current.refresh()
    })

    expect(first!).toBe(second!)
    expect(result.current.isRefreshing).toBe(true)
    expect(queryCount).toBe(2)

    await act(async () => {
      resolveRefresh(INSTALLED_STATUS)
      await first!
    })
    expect(result.current.isRefreshing).toBe(false)
    expect(result.current.status).toEqual(INSTALLED_STATUS)
  })

  it('does not let a stale refresh overwrite a newer install result', async () => {
    let queryCount = 0
    let resolveRefresh: (status: CliToolStatus) => void = () => {}
    let resolveInstall: (status: CliToolStatus) => void = () => {}
    vi.mocked(transport.invoke).mockImplementation((channel) => {
      if (channel === Queries.GetCliToolStatus) {
        queryCount += 1
        if (queryCount === 1) return Promise.resolve(READY_STATUS)
        return new Promise((resolve) => {
          resolveRefresh = resolve
        })
      }
      return new Promise((resolve) => {
        resolveInstall = resolve
      })
    })
    const { result } = renderHook(() => useCliTool())
    await waitFor(() => expect(result.current.status).toEqual(READY_STATUS))

    let refreshPromise: Promise<void>
    act(() => {
      refreshPromise = result.current.refresh()
    })
    expect(result.current.isRefreshing).toBe(true)

    let installPromise: Promise<void>
    act(() => {
      installPromise = result.current.install()
    })
    expect(result.current.isRefreshing).toBe(false)
    expect(result.current.status.phase).toBe(CliToolPhase.Installing)

    await act(async () => {
      resolveInstall(INSTALLED_STATUS)
      await installPromise!
    })
    await act(async () => {
      resolveRefresh(READY_STATUS)
      await refreshPromise!
    })

    expect(result.current.isRefreshing).toBe(false)
    expect(result.current.status).toEqual(INSTALLED_STATUS)
  })

  it('detaches a held install poll before a terminal refresh', async () => {
    vi.useFakeTimers()
    const refreshedStatus: CliToolStatus = {
      ...INSTALLED_STATUS,
      version: '0.5.0',
    }
    let queryCount = 0
    let resolvePoll: (status: CliToolStatus) => void = () => {}
    let resolveInstall: (status: CliToolStatus) => void = () => {}
    vi.mocked(transport.invoke).mockImplementation((channel) => {
      if (channel === Queries.GetCliToolStatus) {
        queryCount += 1
        if (queryCount === 1) return Promise.resolve(READY_STATUS)
        if (queryCount === 2) {
          return new Promise((resolve) => {
            resolvePoll = resolve
          })
        }
        return Promise.resolve(refreshedStatus)
      }
      return new Promise((resolve) => {
        resolveInstall = resolve
      })
    })
    const { result } = renderHook(() => useCliTool())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.status).toEqual(READY_STATUS)

    let installPromise: Promise<void>
    act(() => {
      installPromise = result.current.install()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(queryCount).toBe(2)

    await act(async () => {
      resolveInstall(INSTALLED_STATUS)
      await installPromise!
    })
    expect(result.current.status).toEqual(INSTALLED_STATUS)

    await act(async () => {
      await result.current.refresh()
    })
    expect(queryCount).toBe(3)
    expect(result.current.status).toEqual(refreshedStatus)

    await act(async () => {
      resolvePoll(READY_STATUS)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.status).toEqual(refreshedStatus)
  })

  it('polls once per second while installing and stops at a terminal state', async () => {
    vi.useFakeTimers()
    vi.mocked(transport.invoke)
      .mockResolvedValueOnce({
        ...READY_STATUS,
        phase: CliToolPhase.Installing,
      })
      .mockResolvedValueOnce(INSTALLED_STATUS)

    const { result } = renderHook(() => useCliTool())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.status.phase).toBe(CliToolPhase.Installing)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(result.current.status).toEqual(INSTALLED_STATUS)
    expect(transport.invoke).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(transport.invoke).toHaveBeenCalledTimes(2)
  })

  it('keeps Installing and retries after a passive poll rejection', async () => {
    vi.useFakeTimers()
    vi.mocked(transport.invoke)
      .mockResolvedValueOnce({
        ...READY_STATUS,
        phase: CliToolPhase.Installing,
      })
      .mockRejectedValueOnce(new Error('transient poll failure'))
      .mockResolvedValueOnce(INSTALLED_STATUS)

    const { result } = renderHook(() => useCliTool())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.status.phase).toBe(CliToolPhase.Installing)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(result.current.status.phase).toBe(CliToolPhase.Installing)
    expect(transport.invoke).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(result.current.status).toEqual(INSTALLED_STATUS)
    expect(transport.invoke).toHaveBeenCalledTimes(3)
  })

  it('cleans up polling when unmounted', async () => {
    vi.useFakeTimers()
    vi.mocked(transport.invoke).mockResolvedValue({
      ...READY_STATUS,
      phase: CliToolPhase.Installing,
    })
    const { unmount } = renderHook(() => useCliTool())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(transport.invoke).toHaveBeenCalledTimes(1)

    unmount()
    await vi.advanceTimersByTimeAsync(3000)
    expect(transport.invoke).toHaveBeenCalledTimes(1)
  })

  it('settles an interactive refresh without updating after unmount', async () => {
    let queryCount = 0
    let resolveRefresh: (status: CliToolStatus) => void = () => {}
    vi.mocked(transport.invoke).mockImplementation(() => {
      queryCount += 1
      if (queryCount === 1) return Promise.resolve(READY_STATUS)
      return new Promise((resolve) => {
        resolveRefresh = resolve
      })
    })
    const { result, unmount } = renderHook(() => useCliTool())
    await waitFor(() => expect(result.current.status).toEqual(READY_STATUS))

    let pending: Promise<void>
    act(() => {
      pending = result.current.refresh()
    })
    expect(result.current.isRefreshing).toBe(true)

    unmount()
    await act(async () => {
      resolveRefresh(INSTALLED_STATUS)
      await pending!
    })
    expect(queryCount).toBe(2)
  })

  it('converts unexpected transport failures to a stable fallback', async () => {
    vi.mocked(transport.invoke).mockRejectedValue(new Error('secret detail'))

    const { result } = renderHook(() => useCliTool())

    await waitFor(() =>
      expect(result.current.status.phase).toBe(CliToolPhase.Error)
    )
    expect(result.current.status).toMatchObject({
      capability: CliInstallCapability.ManualOnly,
      installCommand: 'npm install -g @motrix/cli@latest',
      packageManager: CliPackageManager.Unknown,
      reason: CliToolReason.Unknown,
      detail: null,
    })
    expect(result.current.status.managerOptions).toEqual([
      {
        manager: CliPackageManager.Npm,
        installCommand: 'npm install -g @motrix/cli@latest',
        available: false,
      },
      {
        manager: CliPackageManager.Pnpm,
        installCommand: 'pnpm add -g @motrix/cli@latest',
        available: false,
      },
      {
        manager: CliPackageManager.Yarn,
        installCommand: 'yarn global add @motrix/cli@latest',
        available: false,
      },
      {
        manager: CliPackageManager.Bun,
        installCommand: 'bun add -g @motrix/cli@latest',
        available: false,
      },
      {
        manager: CliPackageManager.Volta,
        installCommand: 'volta install @motrix/cli@latest',
        available: false,
      },
    ])
    expect(result.current.selectedManager).toBe(CliPackageManager.Npm)
    expect(result.current.selectedCommand).toBe(
      'npm install -g @motrix/cli@latest'
    )
  })
})
