import type { Transport } from '@renderer/lib/transport/types'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import { DEFAULT_APP_SETTINGS } from '@shared/schemas/app-settings'
import {
  CreateServerDirectoryRequestSchema,
  ListServerDirectoriesRequestSchema,
  ValidateServerDirectoryRequestSchema,
} from '@shared/schemas/server-directory'

const folders = new Map<string, string[]>([
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
  on() {},
  off() {},
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
          paths: [{ path: '/downloads' }, { path: '/archive' }],
          defaultPath: '/downloads',
          allowCustom: true,
        }
      case Queries.ListServerDirectories: {
        const { path, showHidden } = ListServerDirectoriesRequestSchema.parse(
          args[0]
        )
        const children = folders.get(path)
        if (!children)
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
              segments.length === 1
                ? null
                : path.slice(0, path.lastIndexOf('/')),
            breadcrumbs: segments.map((name, index) => ({
              name,
              path: `/${segments.slice(0, index + 1).join('/')}`,
            })),
            entries: children
              .filter((name) => showHidden || !name.startsWith('.'))
              .map((name) => ({ name, path: `${path}/${name}` })),
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
        settings.app = { ...settings.app, ...patch.app }
        return { saved: true, requiresRestart: false, changedRestartKeys: [] }
      }
      case Commands.CreateTask:
        return { outcome: 'created', taskId: 'unexpected-parent-submit' }
      default:
        throw new Error(`Unhandled harness RPC: ${channel}`)
    }
  },
}
