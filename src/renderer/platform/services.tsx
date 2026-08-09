import { createContext, type ReactNode, useContext } from 'react'

export interface PlatformServices {
  readonly kind: 'electron' | 'web'
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
