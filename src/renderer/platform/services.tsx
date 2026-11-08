import type { CloseCurrentWindowPayload } from '@shared/schemas/close-current-window'
import type { FilePickerOptions } from '@shared/schemas/file-picker'
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
  pickFile?(options: FilePickerOptions): Promise<string | null>
  /** Resolve a user-dropped file on this host; absent for remote web sessions. */
  getPathForFile?(file: File): string | null
  pickSaveDir(
    defaultPath?: string,
    options?: {
      /** Draft forms keep application favorites behind their own Save boundary. */
      allowFavoriteEditing?: boolean
    }
  ): Promise<string | null>
  /**
   * Electron uses the payload to focus or navigate the main window after closing.
   * Web hosts ignore it and navigate via `useNavigate()` in the shared React tree.
   */
  closeHost(options?: CloseCurrentWindowPayload): Promise<void> | void
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
