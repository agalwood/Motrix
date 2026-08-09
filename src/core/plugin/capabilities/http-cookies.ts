// Per-plugin RFC 6265 subset cookie jar backed by SQLite (better-sqlite3).
// Each CookieJar instance is scoped to a single pluginId — cookies are never
// visible across plugin boundaries.
//
// Features implemented:
//   - Set-Cookie parsing: name=value + Domain, Path, Expires, Max-Age,
//     Secure, HttpOnly attributes.
//   - Domain scoping: Domain=.example.com matches sub-domains.
//   - Max-Age=0 immediately deletes the cookie.
//   - Secure cookies excluded from http:// requests.
//   - Cross-plugin isolation enforced at the SQL query level.
//
// Schema bootstrap: call `ensureCookieJarSchema(db)` once at startup.
//   Task 18 factory (createElectronCapabilityHost / createServerCapabilityHost)
//   is responsible for this call.
//
// Used by Task 10 (http capability) for the `cookies: 'jar'` option.

import type Database from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

export function ensureCookieJarSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_cookie_jar (
      plugin_id  TEXT NOT NULL,
      domain     TEXT NOT NULL,
      path       TEXT NOT NULL,
      name       TEXT NOT NULL,
      value      TEXT NOT NULL,
      expires_at INTEGER,
      secure     INTEGER NOT NULL DEFAULT 0,
      http_only  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (plugin_id, domain, path, name)
    );
    CREATE INDEX IF NOT EXISTS idx_plugin_cookie_jar_lookup
      ON plugin_cookie_jar(plugin_id, domain);
  `)
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class CookieJarError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'CookieJarError'
  }
}

// ---------------------------------------------------------------------------
// ParsedCookie interface
// ---------------------------------------------------------------------------

export interface ParsedCookie {
  name: string
  value: string
  /** Normalized: leading "." if Domain= attribute was set; bare host otherwise. */
  domain: string
  /** Default '/'. */
  path: string
  /** ms epoch; undefined = session cookie. */
  expiresAt?: number
  secure: boolean
  httpOnly: boolean
}

// ---------------------------------------------------------------------------
// Pure helper: parseSetCookie
// ---------------------------------------------------------------------------

/**
 * Parse a single Set-Cookie header value against the request URL.
 *
 * Returns `ParsedCookie` or `null` when:
 *   - The header has no `=` in its name=value part.
 *   - The Domain attribute doesn't match the request host (cross-domain reject).
 */
export function parseSetCookie(
  headerValue: string,
  requestUrl: string
): ParsedCookie | null {
  // Split parts on ';' and trim whitespace.
  const parts = headerValue.split(';').map((p) => p.trim())
  if (parts.length === 0 || !parts[0]) return null

  // First part must be name=value.
  const eqIdx = parts[0].indexOf('=')
  if (eqIdx === -1) return null

  const name = parts[0].slice(0, eqIdx).trim()
  const value = parts[0].slice(eqIdx + 1).trim()

  if (!name) return null

  // Parse request URL for host context.
  let requestHost: string
  try {
    requestHost = new URL(requestUrl).hostname.toLowerCase()
  } catch {
    return null
  }

  // Defaults.
  let domain = requestHost // bare host; no leading dot
  let path = '/'
  let expiresAt: number | undefined
  let secure = false
  let httpOnly = false
  let maxAgeSet = false

  // Parse attributes (parts[1..]).
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]
    if (!part) continue
    const attrEq = part.indexOf('=')
    const attrName = (attrEq === -1 ? part : part.slice(0, attrEq))
      .trim()
      .toLowerCase()
    const attrValue = attrEq === -1 ? '' : part.slice(attrEq + 1).trim()

    if (attrName === 'domain') {
      if (!attrValue) continue
      const rawDomain = attrValue.toLowerCase()
      // Normalize: add leading dot if missing.
      const normalizedDomain = rawDomain.startsWith('.')
        ? rawDomain
        : `.${rawDomain}`
      // Security: reject if the domain doesn't match the request host.
      // The effective domain (without leading dot) must be a suffix of the
      // request host.
      const effectiveDomain = normalizedDomain.slice(1) // strip leading dot
      if (
        requestHost !== effectiveDomain &&
        !requestHost.endsWith(`.${effectiveDomain}`)
      ) {
        // Cross-domain cookie injection attempt — reject the whole cookie.
        return null
      }
      domain = normalizedDomain
    } else if (attrName === 'path') {
      path = attrValue || '/'
    } else if (attrName === 'max-age') {
      const seconds = Number(attrValue)
      if (!Number.isNaN(seconds)) {
        maxAgeSet = true
        if (seconds <= 0) {
          expiresAt = 0 // signals immediate deletion
        } else {
          expiresAt = Date.now() + seconds * 1000
        }
      }
    } else if (attrName === 'expires' && !maxAgeSet) {
      // Max-Age overrides Expires if both present; only parse if Max-Age not
      // already set.
      const parsed = Date.parse(attrValue)
      if (!Number.isNaN(parsed)) {
        expiresAt = parsed
      }
    } else if (attrName === 'secure') {
      secure = true
    } else if (attrName === 'httponly') {
      httpOnly = true
    }
    // SameSite is intentionally ignored (subset implementation).
  }

  return { name, value, domain, path, expiresAt, secure, httpOnly }
}

// ---------------------------------------------------------------------------
// Row shape for SQLite reads
// ---------------------------------------------------------------------------

interface CookieRow {
  plugin_id: string
  domain: string
  path: string
  name: string
  value: string
  expires_at: number | null
  secure: number
  http_only: number
}

// ---------------------------------------------------------------------------
// CookieJar
// ---------------------------------------------------------------------------

export class CookieJar {
  private readonly pluginId: string

  // Prepared statements — initialized once in constructor, reused across calls.
  private readonly stmtUpsert: Database.Statement
  private readonly stmtDelete: Database.Statement
  private readonly stmtLookup: Database.Statement
  private readonly stmtList: Database.Statement
  private readonly stmtClear: Database.Statement

  constructor(db: Database.Database, pluginId: string) {
    this.pluginId = pluginId

    this.stmtUpsert = db.prepare<
      [string, string, string, string, string, number | null, number, number]
    >(
      `INSERT INTO plugin_cookie_jar
         (plugin_id, domain, path, name, value, expires_at, secure, http_only)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(plugin_id, domain, path, name) DO UPDATE SET
         value      = excluded.value,
         expires_at = excluded.expires_at,
         secure     = excluded.secure,
         http_only  = excluded.http_only`
    )

    this.stmtDelete = db.prepare<[string, string, string, string]>(
      `DELETE FROM plugin_cookie_jar
       WHERE plugin_id = ? AND domain = ? AND path = ? AND name = ?`
    )

    this.stmtLookup = db.prepare<[string], CookieRow>(
      `SELECT plugin_id, domain, path, name, value, expires_at, secure, http_only
       FROM plugin_cookie_jar
       WHERE plugin_id = ?`
    )

    this.stmtList = db.prepare<[string, number], CookieRow>(
      `SELECT plugin_id, domain, path, name, value, expires_at, secure, http_only
       FROM plugin_cookie_jar
       WHERE plugin_id = ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY length(path) DESC, name ASC`
    )

    this.stmtClear = db.prepare<[string]>(
      `DELETE FROM plugin_cookie_jar WHERE plugin_id = ?`
    )
  }

  // -------------------------------------------------------------------------
  // captureFromResponseHeaders
  // -------------------------------------------------------------------------

  /**
   * Parse Set-Cookie headers from an HTTP response and persist matching cookies.
   * Synchronous — better-sqlite3 is sync.
   */
  captureFromResponseHeaders(url: string, setCookieHeaders: string[]): void {
    for (const header of setCookieHeaders) {
      const cookie = parseSetCookie(header, url)
      if (!cookie) continue

      if (cookie.expiresAt === 0) {
        // Max-Age=0 — delete the cookie immediately.
        this.stmtDelete.run(
          this.pluginId,
          cookie.domain,
          cookie.path,
          cookie.name
        )
      } else {
        const expiresAt =
          cookie.expiresAt !== undefined ? cookie.expiresAt : null
        this.stmtUpsert.run(
          this.pluginId,
          cookie.domain,
          cookie.path,
          cookie.name,
          cookie.value,
          expiresAt,
          cookie.secure ? 1 : 0,
          cookie.httpOnly ? 1 : 0
        )
      }
    }
  }

  // -------------------------------------------------------------------------
  // cookieHeader
  // -------------------------------------------------------------------------

  /**
   * Returns the Cookie header value for the given URL, e.g. "a=1; b=2",
   * or '' if no cookies match.
   * Synchronous.
   */
  cookieHeader(url: string): string {
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      return ''
    }

    const targetHost = parsedUrl.hostname.toLowerCase()
    const targetPath = parsedUrl.pathname || '/'
    const isHttps = parsedUrl.protocol === 'https:'
    const now = Date.now()

    const allRows = this.stmtLookup.all(this.pluginId) as CookieRow[]

    const matched: CookieRow[] = []

    for (const row of allRows) {
      // Expiry check.
      if (row.expires_at !== null && row.expires_at <= now) continue

      // Secure flag: exclude secure cookies for non-https requests.
      if (row.secure && !isHttps) continue

      // Domain match.
      const cookieDomain = row.domain.toLowerCase()
      if (cookieDomain.startsWith('.')) {
        // Wildcard: match host itself (without dot) or any subdomain.
        const bare = cookieDomain.slice(1)
        if (targetHost !== bare && !targetHost.endsWith(`.${bare}`)) continue
      } else {
        // Exact host match.
        if (targetHost !== cookieDomain) continue
      }

      // Path match (RFC 6265 §5.1.4 subset): target path must start with
      // cookie path. When cookie path doesn't end with '/', also accept exact
      // match and descendant with '/'.
      const cookiePath = row.path
      if (targetPath !== cookiePath) {
        if (!cookiePath.endsWith('/')) {
          if (!targetPath.startsWith(`${cookiePath}/`)) continue
        } else {
          if (!targetPath.startsWith(cookiePath)) continue
        }
      }

      matched.push(row)
    }

    if (matched.length === 0) return ''

    // Sort: path length desc, then name asc (RFC 6265 §5.4).
    matched.sort((a, b) => {
      const diff = b.path.length - a.path.length
      if (diff !== 0) return diff
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })

    return matched.map((r) => `${r.name}=${r.value}`).join('; ')
  }

  // -------------------------------------------------------------------------
  // list (test/inspection helper)
  // -------------------------------------------------------------------------

  /**
   * Returns all non-expired cookies for this plugin, ordered by path length
   * descending then name ascending. Session cookies (no `expires_at`) are
   * always included. Consistent with `cookieHeader`'s expiry semantics.
   */
  list(): ParsedCookie[] {
    const rows = this.stmtList.all(this.pluginId, Date.now()) as CookieRow[]
    return rows.map((r) => ({
      name: r.name,
      value: r.value,
      domain: r.domain,
      path: r.path,
      expiresAt: r.expires_at !== null ? r.expires_at : undefined,
      secure: r.secure === 1,
      httpOnly: r.http_only === 1,
    }))
  }

  // -------------------------------------------------------------------------
  // clear (test/eviction helper)
  // -------------------------------------------------------------------------

  clear(): void {
    this.stmtClear.run(this.pluginId)
  }
}
