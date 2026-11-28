import { isIP } from 'node:net'
import { z } from 'zod'
import type { DownloadCookie, PreparedDownloadCookies } from '../engine-adapter'
import {
  type TaskCookieDiagnostic,
  TaskCookieError,
} from '../task-cookie-error'

const cookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string().optional(),
  hostOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  httpOnly: z.boolean().optional(),
  expiresAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
})
const tokenName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: HTTP credential delimiters.
const unsafeValue = /[\x00-\x1f\x7f;]/

/** Adapt to the published task-cookie RPC; never rewrite or truncate credentials. */
export function prepareAria2TaskCookies(
  cookies: readonly DownloadCookie[],
  now = Date.now()
): PreparedDownloadCookies {
  const reject = (diagnostic: TaskCookieDiagnostic): never => {
    throw new TaskCookieError(diagnostic)
  }
  if (!Array.isArray(cookies))
    reject({ index: -1, field: 'cookies', reason: 'type' })
  const discarded: TaskCookieDiagnostic[] = []
  const retained = new Map<
    string,
    { cookie: DownloadCookie; host: string; index: number }
  >()
  for (const [index, input] of cookies.entries()) {
    const parsed = cookieSchema.safeParse(input)
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? 'cookie')
      discarded.push({
        index,
        field,
        reason: field === 'expiresAt' ? 'expiry' : 'type',
      })
      continue
    }
    const cookie = parsed.data
    if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
      discarded.push({ index, field: 'expiresAt', reason: 'expired' })
      continue
    }
    const { name, value, domain } = cookie
    const path = cookie.path ?? '/'
    let diagnostic: TaskCookieDiagnostic | undefined
    const invalid = (
      field: string,
      reason: TaskCookieDiagnostic['reason'],
      byteLength?: number
    ) => {
      diagnostic ??= {
        index,
        field,
        reason,
        ...(byteLength === undefined ? {} : { byteLength }),
      }
    }
    for (const [field, text] of [
      ['name', name],
      ['value', value],
      ['domain', domain],
      ['path', path],
    ] as const) {
      if (!text.isWellFormed()) invalid(field, 'syntax')
    }
    const bytes = Buffer.byteLength(name) + Buffer.byteLength(value)
    if (bytes > 4096) invalid('nameValue', 'size', bytes)
    if (!tokenName.test(name)) invalid('name', 'syntax')
    if (unsafeValue.test(value)) invalid('value', 'syntax')
    if (unsafeValue.test(path) || !path.startsWith('/'))
      invalid('path', 'syntax')
    for (const [field, text, limit] of [
      ['domain', domain, 254],
      ['path', path, 4096],
    ] as const) {
      const byteLength = Buffer.byteLength(text)
      if (byteLength > limit) invalid(field, 'size', byteLength)
    }
    // Match the engine's ASCII case folding; Unicode lowercasing can turn an
    // invalid host such as U+212A into an otherwise valid ASCII hostname.
    const host = domain
      .replace(/^\./, '')
      .replace(/[A-Z]/g, (char) => char.toLowerCase())
    if (
      !host ||
      host.startsWith('.') ||
      host.endsWith('.') ||
      host.includes('..') ||
      (!isIP(host) && /[^a-z0-9.-]/.test(host))
    ) {
      invalid('domain', 'domain')
    }
    if (diagnostic) {
      discarded.push(diagnostic)
      continue
    }
    const identity = JSON.stringify([host, path, name])
    const previous = retained.get(identity)
    if (previous)
      discarded.push({
        index: previous.index,
        field: 'cookie',
        reason: 'duplicate',
      })
    // The engine replaces by canonical domain/path/name, preserving first insertion order.
    retained.set(identity, { cookie, host, index })
  }
  if (
    retained.size === 0 &&
    discarded.some((d) => d.reason !== 'expired' && d.reason !== 'duplicate')
  ) {
    reject({ index: -1, field: 'cookies', reason: 'noUsableCookies' })
  }
  if (retained.size > 300)
    reject({ index: -1, field: 'cookies', reason: 'count' })
  const domains = new Map<string, number>()
  for (const { host, index } of retained.values()) {
    const count = (domains.get(host) ?? 0) + 1
    domains.set(host, count)
    // Refuse before creation instead of silently evicting a credential or choosing an arbitrary subset.
    if (count > 50) reject({ index, field: 'domain', reason: 'count' })
  }
  return {
    cookies: [...retained.values()].map((entry) => entry.cookie),
    discarded,
  }
}
