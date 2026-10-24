import path from 'node:path'
import { normalizeAria2TaskProxyUrl } from '@core/proxy/aria2-proxy-routing'
import type { DirectResourceRequestOptions } from '@core/task/direct-resource-validator'
import { AppError, ErrorCode } from '@shared/errors'
import {
  digestBytes,
  parseLegacySession,
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
  let system: Record<string, unknown>
  try {
    system = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(input.system)
    )
    if (!system || Array.isArray(system) || typeof system !== 'object')
      throw failure()
  } catch {
    throw failure()
  }
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

  // Use the parser's exact block digest to retrieve request values without
  // ever adding credentials to its preview/database-facing representation.
  const blocks: string[][] = []
  for (const line of new TextDecoder('utf-8', { fatal: true })
    .decode(input.session)
    .split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue
    if (!/^\s/.test(line)) blocks.push([line])
    else blocks.at(-1)?.push(line)
  }
  const block = blocks.find(
    (lines) => digestBytes(lines.join('\n')) === entry.digest
  )
  if (!block) throw changed()
  const task: Record<string, string[]> = Object.create(null)
  for (const line of block.slice(1)) {
    const match = /^\s+([a-z0-9-]+)=(.*)$/.exec(line)
    if (!match) throw failure()
    task[match[1]] ??= []
    task[match[1]].push(match[2])
  }
  const values = (key: string): string[] => {
    const raw = task[key] ?? system[key]
    if (raw === undefined || raw === null) return []
    const list = Array.isArray(raw) ? raw : [raw]
    if (
      list.some(
        (value) =>
          typeof value !== 'string' &&
          typeof value !== 'boolean' &&
          typeof value !== 'number'
      )
    )
      throw failure()
    return list.map(String)
  }
  const value = (key: string, fallback = ''): string => {
    const list = values(key)
    if (list.length > 1) throw failure()
    const result = list[0] ?? fallback
    if (
      [...result].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
      )
    )
      throw failure()
    return result
  }
  if (
    value('load-cookies') ||
    value('netrc-path') ||
    value('no-netrc') === 'false'
  )
    throw failure()
  for (const [key, baseline] of [
    ['http-accept-gzip', 'false'],
    ['http-auth-challenge', 'false'],
    ['http-no-cache', 'false'],
    ['conditional-get', 'false'],
    ['proxy-method', 'get'],
  ])
    if (value(key, baseline) !== baseline) throw failure()

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
  const inheritedHeaders =
    system.header === undefined || system.header === null
      ? []
      : Array.isArray(system.header)
        ? system.header
        : [system.header]
  if (inheritedHeaders.some((value) => typeof value !== 'string'))
    throw failure()
  for (const line of [
    ...(inheritedHeaders as string[]),
    ...(task.header ?? []),
  ].filter((part) => part.trim())) {
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
  const proxyFor = (prefix: string) => {
    const raw = value(prefix)
    if (!raw) {
      if (value(`${prefix}-user`) || value(`${prefix}-passwd`)) throw failure()
      return ''
    }
    const proxy = normalizeAria2TaskProxyUrl(raw)
    if (!proxy) throw failure()
    const userKey = `${prefix}-user`
    const passKey = `${prefix}-passwd`
    const user = value(userKey)
    const pass = value(passKey)
    try {
      // Dedicated options are raw values and override each URI field only
      // when defined, including an explicitly empty value.
      if (values(userKey).length) proxy.username = encodeURIComponent(user)
      if (values(passKey).length) proxy.password = encodeURIComponent(pass)
    } catch {
      throw failure()
    }
    // aria2 omits userinfo entirely when the resulting username is empty.
    if (!proxy.username) proxy.password = ''
    return proxy.href
  }
  const allProxy = proxyFor('all-proxy')
  const httpProxy = proxyFor('http-proxy') || allProxy
  const httpsProxy = proxyFor('https-proxy') || allProxy
  // Redirects can change protocol. One explicit route must describe both.
  if (httpProxy !== httpsProxy) throw failure()
  if (path.dirname(input.targetPath) === input.targetPath) throw changed()
  return {
    uri,
    headers,
    userAgent,
    proxy: httpProxy,
    noProxy: value('no-proxy'),
  }
}
