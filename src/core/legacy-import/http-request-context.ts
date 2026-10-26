import path from 'node:path'
import type { DirectResourceRequestOptions } from '@core/task/direct-resource-validator'
import { AppError, ErrorCode } from '@shared/errors'
import { parseLegacySystem, resolveLegacyProxyOptions } from './proxy-context'
import {
  digestBytes,
  parseLegacySession,
  resolveLegacyRequestSettings,
  safeLegacyOutput,
} from './session-parser'

const failure = () =>
  new AppError(
    ErrorCode.InvalidSelection,
    'legacyImport.errors.httpRequestUnsupported'
  )
const changed = () =>
  new AppError(ErrorCode.InvalidSelection, 'legacyImport.errors.changedSource')

export interface LegacyHttpRequestContext extends DirectResourceRequestOptions {
  uri: string
  headers: Record<string, string>
  proxy: string
  noProxy: string
  userAgent: string
}

/** Read only a digest-verified profile. Never return raw engine options for replay. */
export function resolveLegacyHttpRequestContext(input: {
  session: Uint8Array
  system: Uint8Array
  itemKey: string
  uris: string[]
  targetPath: string
}): LegacyHttpRequestContext {
  if (input.uris.length !== 1)
    throw new AppError(
      ErrorCode.InvalidSelection,
      'legacyImport.errors.mirrorsUnsupported'
    )
  const system = parseLegacySystem(input.system)
  const entries = parseLegacySession(input.session)
  const matches = entries.filter((entry) => {
    if (entry.gid) return entry.itemKey === input.itemKey
    if (
      !input.itemKey.startsWith('entry:') ||
      !/^https?:\/\//i.test(entry.uris[0] ?? '')
    )
      return false
    try {
      const filename =
        entry.options.out ||
        decodeURIComponent(
          new URL(entry.uris[0]).pathname.split('/').at(-1) || 'download'
        )
      const dir = entry.options.dir ?? system.dir
      const target =
        typeof dir === 'string' ? safeLegacyOutput(dir, filename) : null
      return (
        `entry:${digestBytes(JSON.stringify(['http', target, [...entry.uris].sort()]))}` ===
        input.itemKey
      )
    } catch {
      // An unrelated invalid record does not invalidate the selected task.
      return false
    }
  })
  if (matches.length !== 1) throw changed()
  const entry = matches[0]
  if (
    (entry.reason && entry.reason !== 'request-settings-required') ||
    entry.uris.length !== 1 ||
    entry.uris[0] !== input.uris[0] ||
    safeLegacyOutput(
      entry.options.dir ?? String(system.dir),
      entry.options.out ||
        decodeURIComponent(
          new URL(entry.uris[0]).pathname.split('/').at(-1) || 'download'
        )
    ) !== input.targetPath
  )
    throw changed()
  const uri = entry.uris[0]
  const url = new URL(uri)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw failure()

  // The same filtered, merged values drive preview and actual verification.
  // Private values remain attached to the parsed entry, never its serialized DTO.
  const { values } = resolveLegacyRequestSettings(entry, system, 'http')
  const value = (key: string, fallback = ''): string =>
    values[key]?.at(-1) ?? fallback

  const headers: Record<string, string> = Object.create(null)
  const putHeader = (name: string, content: string) => {
    const key = name.trim().toLowerCase()
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(key) ||
      Object.hasOwn(headers, key) ||
      [...content].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
      )
    )
      throw failure()
    if (['range', 'if-range', 'if-match', 'accept-encoding'].includes(key))
      return
    if (
      [
        'host',
        'connection',
        'content-length',
        'transfer-encoding',
        'proxy-authorization',
      ].includes(key)
    )
      throw failure()
    headers[key] = content
  }
  for (const line of values.header ?? []) {
    const colon = line.indexOf(':')
    if (colon <= 0) throw failure()
    putHeader(line.slice(0, colon), line.slice(colon + 1).trim())
  }
  const referer = value('referer')
  if (referer) {
    if (referer === '*') throw failure()
    putHeader('referer', referer)
  }
  const username = value('http-user')
  const password = value('http-passwd')
  if (username || password) {
    if (!username || username.includes(':')) throw failure()
    putHeader(
      'authorization',
      `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`
    )
  }
  const userAgent = headers['user-agent'] ?? value('user-agent', 'aria2/1.36.0')
  const proxy = resolveLegacyProxyOptions(values)
  if (path.dirname(input.targetPath) === input.targetPath) throw changed()
  return {
    uri,
    headers,
    userAgent,
    // Verification and native continuation both prohibit redirects, so only
    // the original URI's protocol determines this task's route.
    proxy:
      (url.protocol === 'https:' ? proxy.httpsProxy : proxy.httpProxy) ||
      proxy.allProxy,
    noProxy: proxy.noProxy,
  }
}
