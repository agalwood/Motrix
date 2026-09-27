import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { resolveDesktopDirectory } from '@core/settings/directory-preferences'
import {
  type DownloadDirectoriesResult,
  DownloadDirectoriesResultSchema,
  ErrorCodes,
  makeMdxpError,
} from '@motrix/mdxp'

interface DirectorySettings {
  defaultSaveDir: string
  directoryPreferences: { favorites: string[]; recent: string[] }
}

/** No filesystem browsing: only existing user-configured destinations. */
export function createDownloadDirectories(deps: {
  getSettings: () => DirectorySettings
  /** Server injects its allowed-root/symlink policy; Desktop resolves locally. */
  authorizeDirectory?: (path: string) => Promise<string>
}) {
  const authorize = deps.authorizeDirectory ?? resolveDesktopDirectory
  const resolve = async (path: string): Promise<string | null> => {
    try {
      const canonical = await authorize(path)
      await access(canonical, constants.W_OK | constants.X_OK)
      return canonical
    } catch {
      // Do not disclose stale/out-of-scope paths or filesystem error messages.
      return null
    }
  }
  const list = async (): Promise<DownloadDirectoriesResult> => {
    const settings = deps.getSettings()
    const favorites = settings.directoryPreferences.favorites.slice(0, 20)
    const recent = settings.directoryPreferences.recent.slice(0, 10)
    const candidates = [
      ...new Set([settings.defaultSaveDir, ...favorites, ...recent]),
    ]
    const resolved = new Map(
      await Promise.all(
        candidates.map(async (path) => [path, await resolve(path)] as const)
      )
    )
    const group = (paths: string[]) => [
      ...new Set(
        paths.flatMap((path) => {
          const canonical = resolved.get(path)
          return canonical ? [canonical] : []
        })
      ),
    ]
    return DownloadDirectoriesResultSchema.parse({
      defaultSaveDir: resolved.get(settings.defaultSaveDir) ?? null,
      favorites: group(favorites),
      recent: group(recent),
    })
  }
  return {
    list,
    resolveSelection: async (selected: string): Promise<string> => {
      // Rebuild from current settings and re-authorize at submission. Never
      // stat an arbitrary client path and never create a requested directory.
      const current = await list()
      if (
        selected === current.defaultSaveDir ||
        current.favorites.includes(selected) ||
        current.recent.includes(selected)
      )
        return selected
      throw makeMdxpError(
        ErrorCodes.InvalidParams,
        'Download directory is unavailable',
        {
          appCode: 'download-directory-unavailable',
        }
      )
    },
  }
}
