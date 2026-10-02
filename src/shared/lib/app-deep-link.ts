import {
  type AppDeepLinkIntent,
  type AppDeepLinkNotice,
  appDeepLinkRouteSchema,
  MAX_APP_DEEP_LINK_BYTES,
  taskDeepLinkIdSchema,
} from '@shared/schemas/app-deep-link'
import { REGISTRY_PLUGIN_ID_RE } from '@shared/schemas/registry'
import { analyzeDownloadSource } from './download-source'

const RETIRED_COMMANDS = new Set([
  'pause-all-task',
  'resume-all-task',
  'reveal-in-folder',
])

function rejected(notice: AppDeepLinkNotice): AppDeepLinkIntent {
  return { kind: 'rejected', notice }
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(
    (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
  )
}

/** Parse without IO; never turn an external path into an arbitrary app route. */
export function parseAppDeepLink(raw: string): AppDeepLinkIntent {
  if (/^mo:/i.test(raw)) return rejected('deprecatedScheme')
  if (
    raw.length > MAX_APP_DEEP_LINK_BYTES ||
    new TextEncoder().encode(raw).length > MAX_APP_DEEP_LINK_BYTES ||
    /[\s\\]/u.test(raw) ||
    hasControlCharacters(raw)
  )
    return rejected('invalidLink')

  // Parse the original path, not URL.pathname: URL normalizes dot segments
  // before callers can reject them. Only encoded identifiers may contain '/'.
  const parts = /^motrix:\/\/([a-z0-9-]*)((?:\/[^?#]*)?)(?:\?([^#]*))?$/i.exec(
    raw
  )
  if (!parts) return rejected('invalidLink')
  const command = parts[1].toLowerCase()
  const path = parts[2]
  const query = parts[3] ?? ''
  try {
    decodeURIComponent(path)
    decodeURIComponent(query)
  } catch {
    return rejected('invalidLink')
  }
  const params = new URLSearchParams(query)
  const keys = [...params.keys()]
  if (keys.length > 16 || new Set(keys).size !== keys.length)
    return rejected('invalidLink')
  if (RETIRED_COMMANDS.has(command)) return rejected('deprecatedCommand')

  const allowed =
    command === 'new-task' ? ['uri'] : command === 'task-list' ? ['status'] : []
  if (keys.some((key) => !allowed.includes(key)))
    return rejected('unsupportedParameters')

  if (command === 'tasks' || command === 'plugins') {
    if (!/^\/[^/]+\/?$/.test(path)) return rejected('invalidLink')
    const id = decodeURIComponent(path.replace(/^\//, '').replace(/\/$/, ''))
    if (id === '.' || id === '..' || hasControlCharacters(id))
      return rejected('invalidLink')
    if (command === 'tasks') {
      const result = taskDeepLinkIdSchema.safeParse(id)
      return result.success
        ? { kind: 'task', id: result.data }
        : rejected('invalidLink')
    }
    return REGISTRY_PLUGIN_ID_RE.test(id)
      ? { kind: 'plugin', id }
      : rejected('invalidLink')
  }

  if (command === 'downloads') {
    const route = appDeepLinkRouteSchema.safeParse(
      `/downloads/${path === '' || path === '/' ? 'all' : path.slice(1).replace(/\/$/, '').toLowerCase()}`
    )
    return route.success
      ? { kind: 'navigate', route: route.data }
      : rejected('invalidLink')
  }
  if (path !== '' && path !== '/') return rejected('invalidLink')

  switch (command) {
    case '':
      return { kind: 'show' }
    case 'task-list': {
      const status = (params.get('status') ?? 'active').toLowerCase()
      const route = appDeepLinkRouteSchema.safeParse(`/downloads/${status}`)
      if (route.success) return { kind: 'navigate', route: route.data }
      if (status === 'waiting')
        return {
          kind: 'navigate',
          route: '/downloads/active',
          notice: 'waitingMerged',
        }
      return {
        kind: 'navigate',
        route: '/downloads/all',
        notice: status === 'stopped' ? 'stoppedSplit' : 'invalidStatus',
      }
    }
    case 'settings':
    case 'preferences':
      return { kind: 'navigate', route: '/settings' }
    case 'about':
      return { kind: 'navigate', route: '/settings/about' }
    case 'new-bt-task':
      return { kind: 'draft', mode: 'torrent' }
    case 'new-task': {
      if (!params.has('uri')) return { kind: 'draft', mode: 'links' }
      const source = analyzeDownloadSource(params.get('uri') ?? '')
      return source.status === 'accepted'
        ? { kind: 'draft', mode: 'links', url: source.sourceUrl }
        : rejected('invalidSource')
    }
    default:
      return rejected('unsupportedCommand')
  }
}
