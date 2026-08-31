/**
 * Directory-name derivation for the AutoParser "New Task" flow.
 *
 * After a page is parsed we suggest a subdirectory under the user's current
 * save directory so all discovered files land together, e.g.:
 *
 *   https://www.modelscope.cn/models/unsloth/Qwen3.8-27B-GGUF/files
 *     -> unsloth_Qwen3.8-27B-GGUF
 *   https://www.openeuler.openatom.cn/zh/download/#openEuler%2024.03%20LTS%20SP4
 *     -> OpenEuler 24.03 LTS SP4
 *
 * Priority:
 *   1. URL hash fragment (percent-decoded) — the most page-specific signal
 *      and the only meaningful marker on pages whose path is generic.
 *   2. Path segments (trailing noise stripped, last two joined with `_`).
 *
 * The result is always a single sanitized path component. When nothing
 * useful can be derived an empty string is returned and the caller keeps the
 * current save directory untouched.
 */

/** Generic trailing segments stripped before taking the path tail. */
const TRAILING_PATH_NOISE = new Set([
  'files',
  'download',
  'downloads',
  'blob',
  'tree',
  'resolve',
  'raw',
  'view',
  'zh',
  'en',
  'home',
  'index',
  'index.html',
  'default.aspx',
  'default.asp',
])

/** Generic leading segments dropped so a lone content segment can survive. */
const LEADING_PATH_NOISE = new Set([
  'download',
  'downloads',
  'files',
  'blob',
  'tree',
  'resolve',
  'raw',
  'view',
  'zh',
  'en',
  'home',
  'index',
  'models',
  'model',
  'releases',
  'release',
  'page',
])

const FORBIDDEN_CHARS = /[<>:"/\\|?*]/g
const WHITESPACE_RUN = /\s+/g
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i
/** A subdirectory name longer than this loses its last path-like token. */
const MAX_NAME_LENGTH = 80

function safeDecode(component: string): string {
  try {
    return decodeURIComponent(component)
  } catch {
    return component
  }
}

/** Drop C0 control characters (0x00–0x1f) without a control-char regex. */
function stripControlChars(input: string): string {
  return Array.from(input)
    .filter((ch) => ch.charCodeAt(0) >= 0x20)
    .join('')
}

/** Single sanitized path component; '' when nothing survives cleaning. */
function sanitizeDirName(
  raw: string,
  opts: { capitalizeFirst?: boolean } = {}
): string {
  let name = stripControlChars(raw)
    .replace(FORBIDDEN_CHARS, '_')
    .replace(WHITESPACE_RUN, ' ')
    .replace(/^[\s.]+/, '')
    .replace(/[\s.]+$/, '')
  if (!name) return ''
  if (opts.capitalizeFirst) {
    name = name.charAt(0).toUpperCase() + name.slice(1)
  }
  // Leading/trailing dots were trimmed above, so the result can never be a
  // dotfile; just avoid clashing with a Windows reserved device name.
  if (RESERVED_NAME.test(name)) name = `_${name}`
  if (name.length > MAX_NAME_LENGTH) {
    name = name.slice(0, MAX_NAME_LENGTH).replace(/[\s_.]+$/, '')
  }
  return name || ''
}

function dirNameFromHash(url: string): string {
  const hashIndex = url.indexOf('#')
  if (hashIndex < 0) return ''
  const raw = url.slice(hashIndex + 1)
  if (!raw.trim()) return ''
  return sanitizeDirName(safeDecode(raw), { capitalizeFirst: true })
}

function dirNameFromPath(url: string): string {
  let pathname = ''
  try {
    pathname = new URL(url).pathname
  } catch {
    // Last-resort for non-URL inputs: strip scheme://host and any query/hash.
    pathname = `/${url}`
      .replace(/^\/[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
      .split(/[?#]/)[0]
      .replace(/^\/+/, '/')
  }

  const segments = pathname
    .split('/')
    .map(safeDecode)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => sanitizeDirName(s))
    .filter(Boolean)
  if (segments.length === 0) return ''

  const tail = [...segments]
  // Drop trailing noise first (e.g. `/models/u/m/files` → `/models/u/m`).
  while (tail.length > 0) {
    const last = tail[tail.length - 1] as string
    if (!TRAILING_PATH_NOISE.has(last.toLowerCase())) break
    tail.pop()
  }
  // Then drop leading noise so a lone content segment survives (e.g.
  // `/downloads/KeePass-2.47` → `KeePass-2.47` rather than `downloads_…`).
  while (tail.length > 0) {
    const first = tail[0] as string
    if (!LEADING_PATH_NOISE.has(first.toLowerCase())) break
    tail.shift()
  }
  const source = tail.length > 0 ? tail : segments
  const lastTwo = source.slice(-2)
  return sanitizeDirName(lastTwo.join('_'))
}

/**
 * Derive a suggested subdirectory name for the parsed page, or '' when none
 * can be produced. Use the post-redirect `finalUrl` when available because it
 * reflects the page the links were actually extracted from.
 */
export function deriveAutoparserDirName(finalUrl: string): string {
  const fromHash = dirNameFromHash(finalUrl)
  if (fromHash) return fromHash
  return dirNameFromPath(finalUrl)
}

/**
 * Append a single child component to a parent directory using the parent's
 * own separator flavour (Windows `\` vs posix `/`). Browser-safe — no `path`
 * module is used. Returns `parent` unchanged on an empty child.
 */
export function joinParentDir(parent: string, child: string): string {
  if (!child) return parent
  const p = parent.replace(/[/\\]+$/, '')
  const sep = p.includes('\\') ? '\\' : '/'
  return `${p}${sep}${child}`
}
