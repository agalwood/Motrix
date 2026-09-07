import type { Transport } from '@renderer/lib/transport/types'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/app-settings'
import {
  type DirectoryPreferences,
  DirectoryPreferencesSchema,
  GetDirectoryPreferencesRequestSchema,
  MutateDirectoryPreferencesRequestSchema,
} from '@shared/schemas/directory-preferences'
import { SaveGeneralSettingsRequestSchema } from '@shared/schemas/general-settings'
import {
  CreateServerDirectoryRequestSchema,
  ListServerDirectoriesRequestSchema,
  ValidateServerDirectoryRequestSchema,
} from '@shared/schemas/server-directory'

const folders = new Map<string, string[]>([
  ['/', ['archive', 'downloads', 'home']],
  ['/home', ['operator']],
  ['/home/operator', ['Desktop', 'Documents', 'Downloads']],
  ['/home/operator/Desktop', []],
  ['/home/operator/Documents', []],
  ['/home/operator/Downloads', []],
  ['/downloads', ['.hidden', 'Empty', 'Movies', 'Music']],
  ['/downloads/.hidden', []],
  ['/downloads/Empty', []],
  ['/downloads/Movies', ['Classics']],
  ['/downloads/Movies/Classics', []],
  ['/downloads/Music', []],
  [
    '/archive',
    Array.from(
      { length: 800 },
      (_, index) => `Folder ${String(index).padStart(4, '0')}`
    ),
  ],
])
for (const name of folders.get('/archive') ?? [])
  folders.set(`/archive/${name}`, [])

const settings = {
  app: {
    ...DEFAULT_APP_SETTINGS,
    defaultSaveDir: '/downloads',
    autofillClipboardLinks: false,
  },
}

const unrestricted = new URLSearchParams(location.search).has('unrestricted')
const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
const canVisit = (path: string) =>
  folders.has(path) &&
  (unrestricted ||
    ['/downloads', '/archive'].some(
      (root) => path === root || path.startsWith(`${root}/`)
    ))
const preferences = () => structuredClone(settings.app.directoryPreferences)
function setPreferences(value: DirectoryPreferences) {
  settings.app.directoryPreferences = DirectoryPreferencesSchema.parse(value)
  for (const listener of listeners.get(Events.DirectoryPreferencesChanged) ??
    [])
    listener(preferences())
}

export const fixtureState = {
  calls: [] as { channel: string; args: unknown[] }[],
  interactions: [] as {
    type: string
    key?: string
    tag?: string
    label?: string
    time: number
    activeTag?: string
    activeLabel?: string
    stack?: string
  }[],
  createFailure: false,
  mutationFailure: false,
  nativePickerResult: null as string | null,
  nativePickerCalls: 0,
  setPreferences,
  getPreferences: preferences,
  getSettings: () => structuredClone(settings),
  holdChannel: null as string | null,
  releaseRequest: null as (() => void) | null,
}

const error = (code: string) => ({ ok: false, error: { code } })

// Only RPC data and unrelated transport events are replaced. The browser runs
// the actual add-task form, picker, Base UI dialogs, and document shortcuts.
export const transport: Transport = {
  platform:
    new URLSearchParams(location.search).get('transportPlatform') === 'linux'
      ? 'linux'
      : 'web',
  on(channel, listener) {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel)?.add(listener)
  },
  off(channel, listener) {
    listeners.get(channel)?.delete(listener)
  },
  async invoke(channel, ...args) {
    fixtureState.calls.push({ channel, args })
    if (fixtureState.holdChannel === channel) {
      await new Promise<void>((resolve) => {
        fixtureState.releaseRequest = () => {
          fixtureState.releaseRequest = null
          resolve()
        }
      })
    }
    switch (channel) {
      case Queries.GetSettings:
        return settings
      case Queries.ListAllowedSaveDirs:
        return {
          paths: unrestricted
            ? []
            : [{ path: '/downloads' }, { path: '/archive' }],
          defaultPath: '/downloads',
          allowCustom: true,
        }
      case Queries.GetDirectoryPreferences:
        GetDirectoryPreferencesRequestSchema.parse(args[0])
        return { ok: true, value: preferences() }
      case Queries.ListServerDirectoryLocations: {
        GetDirectoryPreferencesRequestSchema.parse(args[0])
        const common = [
          { kind: 'default', path: '/downloads' },
          { kind: 'home', path: '/home/operator' },
          { kind: 'desktop', path: '/home/operator/Desktop' },
          { kind: 'documents', path: '/home/operator/Documents' },
          { kind: 'downloads', path: '/home/operator/Downloads' },
          { kind: 'root', path: '/' },
        ].filter((entry) => canVisit(entry.path))
        const entries = (paths: string[]) =>
          paths.filter(canVisit).map((path) => ({
            name: path.split('/').at(-1) || '/',
            path,
            sourcePaths: [path],
          }))
        return {
          ok: true,
          value: {
            common,
            favorites: entries(settings.app.directoryPreferences.favorites),
            recent: entries(settings.app.directoryPreferences.recent),
          },
        }
      }
      case Commands.MutateDirectoryPreferences: {
        const action = MutateDirectoryPreferencesRequestSchema.parse(args[0])
        if (fixtureState.mutationFailure) return error('unavailable')
        const next = preferences()
        if (
          action.action === 'addFavorite' ||
          action.action === 'recordRecent'
        ) {
          if (!canVisit(action.path)) return error('notFound')
          if (action.action === 'addFavorite') {
            if (!next.favorites.includes(action.path)) {
              if (next.favorites.length >= 20) return error('limitReached')
              next.favorites.push(action.path)
            }
          } else
            next.recent = [
              action.path,
              ...next.recent.filter((path) => path !== action.path),
            ].slice(0, 10)
        } else if (action.action === 'removeFavorite') {
          next.favorites = next.favorites.filter(
            (path) => !action.paths.includes(path)
          )
        } else if (action.action === 'removeRecent') {
          next.recent = next.recent.filter(
            (path) => !action.paths.includes(path)
          )
        } else next.recent = []
        setPreferences(next)
        return { ok: true, value: preferences() }
      }
      case Commands.SaveGeneralSettings: {
        const parsed = SaveGeneralSettingsRequestSchema.safeParse(args[0])
        if (!parsed.success) return error('invalidPath')
        if (fixtureState.mutationFailure) return error('unavailable')
        const { app, directories } = parsed.data
        if (
          (app.defaultSaveDir !== undefined && !canVisit(app.defaultSaveDir)) ||
          directories.addFavorites.some((path) => !canVisit(path))
        )
          return error('notFound')
        // The fixture applies the draft against current committed records in
        // one step, including events received while this request was held.
        const current = preferences()
        const next = {
          favorites: current.favorites.filter(
            (path) => !directories.removeFavorites.includes(path)
          ),
          recent: current.recent.filter(
            (path) => !directories.removeRecent.includes(path)
          ),
        }
        for (const path of directories.addFavorites)
          if (!next.favorites.includes(path)) next.favorites.push(path)
        if (next.favorites.length > 20) return error('limitReached')
        settings.app = { ...settings.app, ...app, directoryPreferences: next }
        if (JSON.stringify(current) !== JSON.stringify(next))
          setPreferences(next)
        return { ok: true, value: preferences() }
      }
      case Queries.ListServerDirectories: {
        const { path, showHidden } = ListServerDirectoriesRequestSchema.parse(
          args[0]
        )
        const children = folders.get(path)
        if (!children || !canVisit(path))
          return error(
            path.startsWith('/downloads/') || path.startsWith('/archive/')
              ? 'notFound'
              : 'outsideRoots'
          )
        const segments = path.split('/').filter(Boolean)
        return {
          ok: true,
          value: {
            path,
            parentPath:
              path === '/' || (!unrestricted && segments.length === 1)
                ? null
                : path.slice(0, path.lastIndexOf('/')) || '/',
            breadcrumbs: [
              ...(unrestricted ? [{ name: '/', path: '/' }] : []),
              ...segments.map((name, index) => ({
                name,
                path: `/${segments.slice(0, index + 1).join('/')}`,
              })),
            ],
            entries: children
              .filter((name) => showHidden || !name.startsWith('.'))
              .map((name) => ({
                name,
                path: `${path === '/' ? '' : path}/${name}`,
              })),
            truncated: false,
            canCreate: true,
          },
        }
      }
      case Queries.ValidateServerDirectory: {
        const { path } = ValidateServerDirectoryRequestSchema.parse(args[0])
        return folders.has(path)
          ? { ok: true, value: { path } }
          : error('notFound')
      }
      case Commands.CreateServerDirectory: {
        const { parentPath, name } = CreateServerDirectoryRequestSchema.parse(
          args[0]
        )
        if (fixtureState.createFailure) return error('permissionDenied')
        const children = folders.get(parentPath)
        if (!children) return error('notFound')
        if (children.includes(name)) return error('alreadyExists')
        const path = `${parentPath}/${name}`
        folders.set(path, [])
        children.push(name)
        children.sort((left, right) =>
          left.localeCompare(right, 'en', { numeric: true })
        )
        return { ok: true, value: { name, path } }
      }
      case Commands.UpdateSettings: {
        const patch = args[0] as { app?: Partial<typeof settings.app> }
        settings.app = {
          ...settings.app,
          ...patch.app,
          directoryPreferences: preferences(),
        }
        return { saved: true, requiresRestart: false, changedRestartKeys: [] }
      }
      case Commands.CreateTask:
        return { outcome: 'created', taskId: 'unexpected-parent-submit' }
      default:
        throw new Error(`Unhandled harness RPC: ${channel}`)
    }
  },
}
