import { isIP } from 'node:net'
import { z } from 'zod'
import type { DownloadCookie } from '../engine-adapter'
import {
  type TaskCookieDiagnostic,
  TaskCookieError,
} from '../task-cookie-error'

export const BROWSER_COOKIES_FEATURE = 'Browser-Cookies'

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

/** Project the RPC whitelist and validate without mutating or logging credentials. */
export function prepareAria2TaskCookies(
  cookies: readonly DownloadCookie[],
  browserCompatible: boolean
): DownloadCookie[] {
  const reject = (diagnostic: TaskCookieDiagnostic): never => {
    throw new TaskCookieError(diagnostic)
  }
  if (!Array.isArray(cookies))
    reject({ index: -1, field: 'cookies', reason: 'type' })
  if (cookies.length > 300)
    reject({ index: -1, field: 'cookies', reason: 'count' })
  const domains = new Map<string, Set<string>>()
  return cookies.map((input, index) => {
    const parsed = cookieSchema.safeParse(input)
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? 'cookie')
      return reject({
        index,
        field,
        reason: field === 'expiresAt' ? 'expiry' : 'type',
      })
    }
    const cookie = parsed.data
    const { name, value, domain } = cookie
    const path = cookie.path ?? '/'
    for (const [field, text] of [
      ['name', name],
      ['value', value],
      ['domain', domain],
      ['path', path],
    ] as const) {
      if (!text.isWellFormed()) reject({ index, field, reason: 'syntax' })
    }
    const bytes = Buffer.byteLength(name) + Buffer.byteLength(value)
    if (bytes > 4096)
      reject({ index, field: 'nameValue', reason: 'size', byteLength: bytes })
    if (
      unsafeValue.test(name) ||
      name.includes('=') ||
      (!name && (!value || value.includes('=')))
    ) {
      reject({ index, field: 'name', reason: 'syntax' })
    }
    if (unsafeValue.test(value))
      reject({ index, field: 'value', reason: 'syntax' })
    if (unsafeValue.test(path) || !path.startsWith('/'))
      reject({ index, field: 'path', reason: 'syntax' })
    for (const [field, text, limit] of [
      ['domain', domain, 254],
      ['path', path, 4096],
    ] as const) {
      const byteLength = Buffer.byteLength(text)
      if (byteLength > limit)
        reject({ index, field, reason: 'size', byteLength })
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
      reject({ index, field: 'domain', reason: 'domain' })
    }
    if (!browserCompatible && !tokenName.test(name))
      reject({ index, field: 'name', reason: 'unsupportedEngine' })
    // Legacy jars silently evict the oldest credential after 50 per domain.
    if (
      !browserCompatible &&
      (cookie.expiresAt === undefined ||
        cookie.expiresAt > Math.floor(Date.now() / 1000) * 1000)
    ) {
      const entries = domains.get(host) ?? new Set<string>()
      entries.add(JSON.stringify([name, path]))
      domains.set(host, entries)
      if (entries.size > 50)
        reject({ index, field: 'cookies', reason: 'unsupportedEngine' })
    }
    return cookie
  })
}
