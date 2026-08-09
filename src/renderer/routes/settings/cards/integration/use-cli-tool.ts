import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  CLI_INSTALL_PACKAGE_MANAGERS,
  CliInstallCapability,
  type CliInstallPackageManager,
  type CliInstallRequest,
  CliPackageManager,
  type CliPackageManagerOption,
  CliToolPhase,
  CliToolReason,
  type CliToolStatus,
} from '@shared/types/cli-tool'
import { useCallback, useEffect, useRef, useState } from 'react'

const FALLBACK_INSTALL_COMMAND = 'npm install -g @motrix/cli@latest'

const FALLBACK_MANAGER_OPTIONS: CliPackageManagerOption[] = [
  {
    manager: CliPackageManager.Npm,
    installCommand: FALLBACK_INSTALL_COMMAND,
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
]

const CHECKING_STATUS: CliToolStatus = {
  phase: CliToolPhase.Checking,
  capability: CliInstallCapability.ManualOnly,
  installCommand: FALLBACK_INSTALL_COMMAND,
  packageManager: CliPackageManager.Unknown,
  managerOptions: FALLBACK_MANAGER_OPTIONS,
  version: null,
  executablePath: null,
  nodeVersion: null,
  reason: null,
  detail: null,
}

const TRANSPORT_ERROR_STATUS: CliToolStatus = {
  ...CHECKING_STATUS,
  phase: CliToolPhase.Error,
  reason: CliToolReason.Unknown,
}

enum StatusQueryMode {
  Initial = 'initial',
  Interactive = 'interactive',
  Poll = 'poll',
}

enum SelectionPolicy {
  Preserve = 'preserve',
  AdoptBackend = 'adopt-backend',
}

interface InstallSelectionIntent {
  requestedManager: CliInstallPackageManager
  explicitlySelected: boolean
}

interface ReconciledSelection {
  manager: CliInstallPackageManager
  command: string
  userSelected: boolean
}

function isInstallPackageManager(
  manager: CliPackageManager
): manager is CliInstallPackageManager {
  return CLI_INSTALL_PACKAGE_MANAGERS.includes(
    manager as CliInstallPackageManager
  )
}

function findManagerOption(
  status: CliToolStatus,
  manager: CliInstallPackageManager
): CliPackageManagerOption | undefined {
  return status.managerOptions.find((option) => option.manager === manager)
}

function isManagerSelectable(
  status: CliToolStatus,
  manager: CliInstallPackageManager
): boolean {
  const option = findManagerOption(status, manager)
  if (!option) return false

  return !(
    status.phase === CliToolPhase.Ready &&
    status.capability === CliInstallCapability.Direct &&
    !option.available
  )
}

function backendDefaultManager(
  status: CliToolStatus
): CliInstallPackageManager {
  if (
    isInstallPackageManager(status.packageManager) &&
    isManagerSelectable(status, status.packageManager)
  ) {
    return status.packageManager
  }

  const commandMatch = status.managerOptions.find(
    (option) =>
      option.installCommand === status.installCommand &&
      isManagerSelectable(status, option.manager)
  )
  if (commandMatch) return commandMatch.manager

  return (
    status.managerOptions.find((option) =>
      isManagerSelectable(status, option.manager)
    )?.manager ?? CliPackageManager.Npm
  )
}

function installCommandManager(
  status: CliToolStatus
): CliInstallPackageManager | undefined {
  return status.managerOptions.find(
    (option) => option.installCommand === status.installCommand
  )?.manager
}

function reconcileSelection(
  status: CliToolStatus,
  currentManager: CliInstallPackageManager | null,
  userSelected: boolean,
  policy: SelectionPolicy,
  installIntent?: InstallSelectionIntent
): ReconciledSelection {
  const manager =
    policy === SelectionPolicy.AdoptBackend
      ? (installCommandManager(status) ?? backendDefaultManager(status))
      : userSelected &&
          currentManager !== null &&
          isManagerSelectable(status, currentManager)
        ? currentManager
        : backendDefaultManager(status)
  const option = findManagerOption(status, manager)

  return {
    manager,
    command:
      policy === SelectionPolicy.AdoptBackend && status.installCommand
        ? status.installCommand
        : (option?.installCommand ?? FALLBACK_INSTALL_COMMAND),
    userSelected:
      policy === SelectionPolicy.AdoptBackend
        ? Boolean(
            installIntent?.explicitlySelected &&
              installIntent.requestedManager === manager &&
              isManagerSelectable(status, manager)
          )
        : Boolean(
            userSelected &&
              currentManager === manager &&
              isManagerSelectable(status, manager)
          ),
  }
}

export interface UseCliToolResult {
  status: CliToolStatus
  selectedManager: CliInstallPackageManager
  selectedCommand: string
  isRefreshing: boolean
  selectManager: (manager: CliInstallPackageManager) => void
  install: () => Promise<void>
  refresh: () => Promise<void>
}

export function useCliTool(): UseCliToolResult {
  const [status, setStatus] = useState<CliToolStatus>(CHECKING_STATUS)
  const [selectedManager, setSelectedManager] =
    useState<CliInstallPackageManager>(CliPackageManager.Npm)
  const [selectedCommand, setSelectedCommand] = useState(
    FALLBACK_INSTALL_COMMAND
  )
  const [isRefreshing, setIsRefreshing] = useState(false)
  const selectedManagerRef = useRef<CliInstallPackageManager | null>(null)
  const userSelectedManagerRef = useRef(false)
  const mountedRef = useRef(true)
  const generationRef = useRef(0)
  const statusQueryPromiseRef = useRef<Promise<void> | null>(null)
  const statusQueryReportsFailureRef = useRef(false)
  const installPromiseRef = useRef<Promise<void> | null>(null)

  const applyStatus = useCallback(
    (
      next: CliToolStatus,
      selectionPolicy = SelectionPolicy.Preserve,
      installIntent?: InstallSelectionIntent
    ) => {
      if (!mountedRef.current) return

      const selection = reconcileSelection(
        next,
        selectedManagerRef.current,
        userSelectedManagerRef.current,
        selectionPolicy,
        installIntent
      )
      userSelectedManagerRef.current = selection.userSelected
      selectedManagerRef.current = selection.manager
      setSelectedManager(selection.manager)
      setSelectedCommand(selection.command)
      setStatus(next)
    },
    []
  )

  const detachStatusQuery = useCallback(() => {
    ++generationRef.current
    statusQueryPromiseRef.current = null
    statusQueryReportsFailureRef.current = false
  }, [])

  const queryStatus = useCallback(
    (mode: StatusQueryMode): Promise<void> => {
      const interactive = mode === StatusQueryMode.Interactive
      const reportsFailure = mode !== StatusQueryMode.Poll
      if (statusQueryPromiseRef.current) {
        if (interactive && mountedRef.current) setIsRefreshing(true)
        if (reportsFailure) statusQueryReportsFailureRef.current = true
        return statusQueryPromiseRef.current
      }

      if (interactive && mountedRef.current) setIsRefreshing(true)
      statusQueryReportsFailureRef.current = reportsFailure
      const generation = ++generationRef.current
      let pending: Promise<void>
      pending = transport
        .invoke(Queries.GetCliToolStatus)
        .then((next) => {
          if (generation === generationRef.current) {
            applyStatus(next as CliToolStatus)
          }
        })
        .catch(() => {
          if (
            generation === generationRef.current &&
            statusQueryReportsFailureRef.current
          ) {
            applyStatus(TRANSPORT_ERROR_STATUS)
          }
        })
        .finally(() => {
          if (statusQueryPromiseRef.current !== pending) return
          statusQueryPromiseRef.current = null
          statusQueryReportsFailureRef.current = false
          if (mountedRef.current) setIsRefreshing(false)
        })

      statusQueryPromiseRef.current = pending
      return pending
    },
    [applyStatus]
  )

  const refresh = useCallback(
    () => queryStatus(StatusQueryMode.Interactive),
    [queryStatus]
  )

  const selectManager = useCallback(
    (manager: CliInstallPackageManager) => {
      if (!isManagerSelectable(status, manager)) return

      const option = findManagerOption(status, manager)
      if (!option) return
      userSelectedManagerRef.current = true
      selectedManagerRef.current = manager
      setSelectedManager(manager)
      setSelectedCommand(option.installCommand)
    },
    [status]
  )

  const install = useCallback((): Promise<void> => {
    if (installPromiseRef.current) return installPromiseRef.current

    const packageManager =
      selectedManagerRef.current ?? backendDefaultManager(status)
    const request: CliInstallRequest = { packageManager }
    const installIntent: InstallSelectionIntent = {
      requestedManager: packageManager,
      explicitlySelected:
        userSelectedManagerRef.current &&
        selectedManagerRef.current === packageManager,
    }

    detachStatusQuery()
    if (mountedRef.current) setIsRefreshing(false)
    applyStatus({ ...status, phase: CliToolPhase.Installing })

    const pending = transport
      .invoke(Commands.InstallCliTool, request)
      .then((next) => {
        detachStatusQuery()
        applyStatus(
          next as CliToolStatus,
          SelectionPolicy.AdoptBackend,
          installIntent
        )
      })
      .catch(() => {
        detachStatusQuery()
        applyStatus(TRANSPORT_ERROR_STATUS)
      })
      .finally(() => {
        if (installPromiseRef.current === pending) {
          installPromiseRef.current = null
        }
      })

    installPromiseRef.current = pending
    return pending
  }, [applyStatus, detachStatusQuery, status])

  useEffect(() => {
    mountedRef.current = true
    void queryStatus(StatusQueryMode.Initial)
    return () => {
      mountedRef.current = false
      detachStatusQuery()
    }
  }, [detachStatusQuery, queryStatus])

  useEffect(() => {
    if (status.phase !== CliToolPhase.Installing) return
    const timer = window.setInterval(() => {
      void queryStatus(StatusQueryMode.Poll)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [queryStatus, status.phase])

  return {
    status,
    selectedManager,
    selectedCommand,
    isRefreshing,
    selectManager,
    install,
    refresh,
  }
}
