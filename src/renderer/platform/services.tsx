import { createContext, type ReactNode, useContext } from 'react'

export type PluginInstallFileReference =
  | { sourceType: 'local'; absPath: string; fileHash: string }
  | { sourceType: 'upload'; uploadId: string; fileHash: string }

export interface PluginInstallFileCapability {
  readonly mode: 'local-path' | 'upload'
  prepare(file: File): Promise<PluginInstallFileReference>
}

export interface PlatformServices {
  readonly kind: 'electron' | 'web'
  readonly pluginInstallFile?: PluginInstallFileCapability
  pickSaveDir(defaultPath?: string): Promise<string | null>
  closeHost(options?: {
    showMain?: boolean
    /**
     * Electron only: after closing this child window and showing main,
     * ask the main window's React Router to navigate to this path.
     * Web ignores this — web hosts (e.g. dialogs) navigate via
     * `useNavigate()` directly because they share the main React tree.
     */
    navigateMainTo?: string
  }): Promise<void> | void
  readClipboard(): Promise<string>
  openExternal(url: string): Promise<void> | void
  notify(
    kind: 'info' | 'warn' | 'error',
    messageKey: string,
    values?: Record<string, unknown>
  ): void
}

const PlatformServicesContext = createContext<PlatformServices | null>(null)

export function PlatformServicesProvider({
  services,
  children,
}: {
  services: PlatformServices
  children: ReactNode
}) {
  return (
    <PlatformServicesContext value={services}>
      {children}
    </PlatformServicesContext>
  )
}

export function usePlatformServices(): PlatformServices {
  const ctx = useContext(PlatformServicesContext)
  if (!ctx) {
    throw new Error(
      'usePlatformServices must be used within <PlatformServicesProvider>'
    )
  }
  return ctx
}

export function useOptionalPlatformServices(): PlatformServices | null {
  return useContext(PlatformServicesContext)
}
