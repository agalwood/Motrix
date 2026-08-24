import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import type {
  AppImageIntegrationDecision,
  AppImageIntegrationHealth,
  AppImageIntegrationOwner,
} from '@shared/types/appimage-integration'
import { z } from 'zod'

// AppImage desktop self-integration (Layer 2).
//
// When Motrix runs as a packaged Linux AppImage it is not installed through a
// package manager, so nothing registers its desktop entry, icon, or the URL
// scheme / mime handlers a browser needs to hand downloads back to it. This
// module owns an opt-in, self-healing integration into the user-scope XDG data
// tree. Everything here is pure or takes injected ports (`IntegrationFs`,
// `CommandRunner`, `IntegrationStore`, `prompt`) so the whole state machine is
// unit-testable without touching the real filesystem or spawning `xdg-*`.
//
// Scope boundary: this is desktop integration only. Native-messaging host
// installation (Layer 3a) is intentionally NOT performed here — the `nmConsent`
// sub-consent is threaded through the record and the transaction leaves marked
// TODO seams where the NM copy/sync steps will slot in.

// ── Persisted record ────────────────────────────────────

// The decision/owner/health unions are shared with the renderer-facing view
// (`AppImageIntegrationView`), so they live in the shared contract layer.
export type IntegrationDecision = AppImageIntegrationDecision
export type IntegrationOwner = AppImageIntegrationOwner
export type IntegrationStatus = AppImageIntegrationHealth
export type NmConsent = 'unset' | 'accepted' | 'declined'

export interface IntegrationRecord {
  decision: IntegrationDecision
  owner: IntegrationOwner
  desktopId: string | null
  status: IntegrationStatus
  // Dependent sub-consent for native-messaging host installation (Layer 3a).
  // Only meaningful once `decision === 'accepted'`; `declined` means no NM
  // writes ever happen.
  nmConsent: NmConsent
  // The scheme/mime default handlers recorded before we overrode them, so a
  // later removal can restore what the user had.
  previousSchemeHandler: string | null
  previousTorrentHandler: string | null
  previousMagnetHandler: string | null
  // Random per-install id embedded in our desktop entry as an ownership proof.
  // A copyable marker key alone cannot prove WE wrote a file (a foreign file
  // can carry the same marker); the id, generated once and known only from our
  // own persisted record, distinguishes our entry from another AppImage
  // install writing the same fixed filename, and gates every overwrite/delete.
  installId: string | null
  // sha256 of the icon bytes we last wrote, so removal only deletes an icon
  // that still matches what we installed (an icon file carries no marker).
  iconSha256: string | null
}

export const DEFAULT_INTEGRATION_RECORD: IntegrationRecord = {
  decision: 'unset',
  owner: null,
  desktopId: null,
  status: null,
  nmConsent: 'unset',
  previousSchemeHandler: null,
  previousTorrentHandler: null,
  previousMagnetHandler: null,
  installId: null,
  iconSha256: null,
}

const integrationRecordSchema = z
  .object({
    decision: z
      .enum(['unset', 'accepted', 'declined'])
      .catch(DEFAULT_INTEGRATION_RECORD.decision),
    owner: z
      .enum(['self', 'external'])
      .nullable()
      .catch(DEFAULT_INTEGRATION_RECORD.owner),
    desktopId: z
      .string()
      .nullable()
      .catch(DEFAULT_INTEGRATION_RECORD.desktopId),
    status: z
      .enum(['healthy', 'failed'])
      .nullable()
      .catch(DEFAULT_INTEGRATION_RECORD.status),
    nmConsent: z
      .enum(['unset', 'accepted', 'declined'])
      .catch(DEFAULT_INTEGRATION_RECORD.nmConsent),
    previousSchemeHandler: z
      .string()
      .nullable()
      .catch(DEFAULT_INTEGRATION_RECORD.previousSchemeHandler),
    previousTorrentHandler: z
      .string()
      .nullable()
      .catch(DEFAULT_INTEGRATION_RECORD.previousTorrentHandler),
    previousMagnetHandler: z
      .string()
      .nullable()
      .catch(DEFAULT_INTEGRATION_RECORD.previousMagnetHandler),
    installId: z
      .string()
      .nullable()
      .catch(DEFAULT_INTEGRATION_RECORD.installId),
    iconSha256: z
      .string()
      .nullable()
      .catch(DEFAULT_INTEGRATION_RECORD.iconSha256),
  })
  .catch(DEFAULT_INTEGRATION_RECORD)

export function parseIntegrationRecord(value: unknown): IntegrationRecord {
  return integrationRecordSchema.parse(value)
}

// ── Identity / paths ────────────────────────────────────

// Deliberately unique names so removal never touches a `motrix.desktop` or icon
// installed by a deb/rpm/Flatpak alongside this AppImage.
export const DESKTOP_ENTRY_ID = 'motrix-appimage.desktop'
export const ICON_NAME = 'motrix-appimage'
export const OWNERSHIP_MARKER_KEY = 'X-Motrix-Integration'
export const OWNERSHIP_MARKER_VALUE = 'appimage'
// Per-install ownership proof embedded alongside the marker (see IntegrationRecord.installId).
export const OWNERSHIP_ID_KEY = 'X-Motrix-Integration-Id'

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

// A path is unsafe to serialize into a `.desktop` file if it carries any C0
// control character — most importantly LF/CR, which would let a crafted
// $APPIMAGE path inject a second `Exec=` line (a last-key-wins desktop parser
// would then run the injected command). Reject rather than try to escape.
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting C0 controls is the point
const CONTROL_CHARS = /[\x00-\x1f\x7f]/
export function isSafeAppImagePath(value: string): boolean {
  return value.length > 0 && !CONTROL_CHARS.test(value)
}

// A desktop id is safe to hand to `xdg-mime` / to resolve on the filesystem
// only if it is a flat `*.desktop` basename: no path separators, no `..`, no
// leading `-` (which some `xdg-mime` builds would parse as an option), and no
// control/whitespace characters.
export function isSafeDesktopId(id: string): boolean {
  return (
    id.length > 0 &&
    id.endsWith('.desktop') &&
    !id.includes('/') &&
    !id.includes('\\') &&
    !id.includes('..') &&
    !id.startsWith('-') &&
    !CONTROL_CHARS.test(id) &&
    !/\s/.test(id)
  )
}

// The install id is embedded verbatim into the desktop file, so it must never
// carry a newline (which would inject a second key/line) or other control
// characters. We generate UUIDs, but a tampered persisted record could hold
// anything — validate before trusting or writing it.
export function isSafeInstallId(id: string | null): id is string {
  return (
    id != null && id.length > 0 && id.length <= 128 && !CONTROL_CHARS.test(id)
  )
}

const SCHEME_MIME = 'x-scheme-handler/motrix'
const TORRENT_MIME = 'application/x-bittorrent'
const MAGNET_MIME = 'x-scheme-handler/magnet'
const MIME_TYPES =
  'application/x-bittorrent;x-scheme-handler/magnet;x-scheme-handler/motrix;'

export function resolveXdgDataHome(
  env: NodeJS.ProcessEnv,
  homedir: string
): string {
  const configured = env.XDG_DATA_HOME
  if (configured && path.isAbsolute(configured)) return configured
  return path.join(homedir, '.local', 'share')
}

export function resolveXdgConfigHome(
  env: NodeJS.ProcessEnv,
  homedir: string
): string {
  const configured = env.XDG_CONFIG_HOME
  if (configured && path.isAbsolute(configured)) return configured
  return path.join(homedir, '.config')
}

export function applicationsDir(dataHome: string): string {
  return path.join(dataHome, 'applications')
}

export function desktopEntryFilePath(dataHome: string): string {
  return path.join(applicationsDir(dataHome), DESKTOP_ENTRY_ID)
}

export function iconFilePath(dataHome: string): string {
  return path.join(
    dataHome,
    'icons',
    'hicolor',
    '256x256',
    'apps',
    `${ICON_NAME}.png`
  )
}

// ── Desktop Entry Exec serialization ────────────────────
//
// Two escaping layers per the freedesktop.org Desktop Entry spec:
//   1. Argument quoting: an argument containing a reserved character is wrapped
//      in double quotes, and `"`, backtick, `$`, `\` inside the quotes are each
//      prefixed with a backslash.
//   2. String-value escaping applied to the whole Exec value: literal `\`
//      becomes `\\` and the field-code introducer `%` becomes `%%`.
// The spec mandates layer 2 is conceptually applied after layer 1, which is why
// a literal backslash inside a quoted argument ends up as four backslashes.

const EXEC_RESERVED = /[\s"'\\><~|&;$*?#()`]/

function quoteExecArg(arg: string): string {
  if (!EXEC_RESERVED.test(arg)) return arg
  const escaped = arg.replace(/(["`$\\])/g, '\\$1')
  return `"${escaped}"`
}

export function serializeExecValue(argv: string[]): string {
  const quoted = argv.map(quoteExecArg).join(' ')
  return quoted.replace(/\\/g, '\\\\').replace(/%/g, '%%')
}

// Reverse of `serializeExecValue`, plus tolerant handling of standalone field
// codes (`%U`, `%f`, …) so a full `Exec=` line can be tokenized. Field-code
// tokens are dropped from the returned argv.
export function parseExecValue(value: string): string[] {
  // Undo the string-value layer first: collapse `\\`→`\` and `%%`→`%` in a
  // single left-to-right pass so `\\\\` does not over-collapse.
  let unescaped = ''
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    const next = value[i + 1]
    if (ch === '\\' && next === '\\') {
      unescaped += '\\'
      i++
    } else if (ch === '%' && next === '%') {
      unescaped += '%'
      i++
    } else {
      unescaped += ch
    }
  }

  const args: string[] = []
  let current = ''
  let inQuotes = false
  let started = false
  for (let i = 0; i < unescaped.length; i++) {
    const ch = unescaped[i]
    if (inQuotes) {
      if (ch === '\\') {
        current += unescaped[++i] ?? ''
      } else if (ch === '"') {
        inQuotes = false
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
      started = true
    } else if (/\s/.test(ch)) {
      if (started) {
        args.push(current)
        current = ''
        started = false
      }
    } else {
      current += ch
      started = true
    }
  }
  if (started) args.push(current)

  return args.filter((arg) => !/^%[a-zA-Z]$/.test(arg))
}

// ── Desktop entry document ──────────────────────────────

export interface BuildDesktopEntryOptions {
  appImagePath: string
  installId: string
}

export class UnsafeAppImagePathError extends Error {}

export function buildDesktopEntry(opts: BuildDesktopEntryOptions): string {
  // Defense in depth against Exec-line injection: never emit a desktop file
  // for a path carrying control characters (LF/CR could inject a second
  // `Exec=`). Callers gate on `isSafeAppImagePath` first; throwing here means
  // no code path can serialize an unsafe path.
  if (!isSafeAppImagePath(opts.appImagePath)) {
    throw new UnsafeAppImagePathError(
      'refusing to build desktop entry for a path with control characters'
    )
  }
  // The install id is written verbatim as its own key; a control character
  // (e.g. a newline from a tampered state file) would inject another line.
  if (!isSafeInstallId(opts.installId)) {
    throw new UnsafeAppImagePathError(
      'refusing to build desktop entry for an unsafe install id'
    )
  }
  const exec = `${serializeExecValue([opts.appImagePath])} %U`
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Motrix',
    'GenericName=Download Manager',
    'Comment=Full-featured download manager',
    `Exec=${exec}`,
    `Icon=${ICON_NAME}`,
    'Terminal=false',
    'Categories=Network;FileTransfer;',
    'Keywords=download;bittorrent;magnet;aria2;',
    `MimeType=${MIME_TYPES}`,
    'StartupWMClass=Motrix',
    'StartupNotify=true',
    `${OWNERSHIP_MARKER_KEY}=${OWNERSHIP_MARKER_VALUE}`,
    `${OWNERSHIP_ID_KEY}=${opts.installId}`,
    '',
  ]
  return lines.join('\n')
}

// Minimal parser for the `[Desktop Entry]` group. Values are returned raw (still
// escaped) — callers that need the Exec argv run it through `parseExecValue`.
export function parseDesktopEntry(content: string): Map<string, string> {
  const entries = new Map<string, string>()
  let inGroup = false
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('[') && line.endsWith(']')) {
      inGroup = line === '[Desktop Entry]'
      continue
    }
    if (!inGroup || line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (!entries.has(key)) entries.set(key, value)
  }
  return entries
}

// Ownership requires BOTH the marker AND the per-install id matching our own
// persisted record. The marker alone is copyable and proves nothing; the id is
// only known from our record, so a foreign file (another AppImage install, a
// user-crafted file, a stale entry) is never treated as ours.
export function isOwnedBySelf(
  entry: Map<string, string>,
  installId: string | null
): boolean {
  return (
    installId != null &&
    entry.get(OWNERSHIP_MARKER_KEY) === OWNERSHIP_MARKER_VALUE &&
    entry.get(OWNERSHIP_ID_KEY) === installId
  )
}

// The Exec launches THIS AppImage only when the program (argv[0]) IS the
// AppImage path — not merely when the path appears somewhere in the argv (an
// `Exec=/usr/bin/echo /path/Motrix.AppImage` handler must not count).
export function execTargetsAppImage(
  execValue: string,
  appImagePath: string
): boolean {
  return parseExecValue(execValue)[0] === appImagePath
}

export type RewriteDecision = 'ok' | 'drift' | 'conflict'

// Decide what to do with the file currently at our desktop path:
//   - `ok`      it is ours and already targets the current AppImage.
//   - `drift`   it is ours but the Exec points elsewhere (updated/moved
//               AppImage) — safe to rewrite in place.
//   - `conflict` it is NOT ours (missing/mismatched id) — a foreign file we
//               must never overwrite.
export function classifyDesktopFile(
  content: string,
  appImagePath: string,
  installId: string | null
): RewriteDecision {
  const entry = parseDesktopEntry(content)
  if (!isOwnedBySelf(entry, installId)) return 'conflict'
  const exec = entry.get('Exec') ?? ''
  return execTargetsAppImage(exec, appImagePath) ? 'ok' : 'drift'
}

// ── External-owner classification ───────────────────────

export interface ClassifyDefaultHandlerOptions {
  handlerId: string | null
  resolvedEntry: Map<string, string> | null
  appImagePath: string
  installId: string | null
}

// Decide who owns the current `x-scheme-handler/motrix` default. `external` is
// only reported when the resolved desktop file is a launchable application
// whose program (argv[0]) actually IS this AppImage — so a stale entry, a deb
// Motrix (which points elsewhere), a disabled entry, or a handler that merely
// mentions the path as an argument is never mistaken for a working
// integration. The handler id must also be a safe flat `*.desktop` name.
export function classifyDefaultHandler(
  opts: ClassifyDefaultHandlerOptions
): 'self' | 'external' | 'none' {
  const { handlerId, resolvedEntry, appImagePath, installId } = opts
  if (!handlerId || !resolvedEntry) return 'none'
  if (!isSafeDesktopId(handlerId)) return 'none'
  if (!isUsableHandlerEntry(resolvedEntry)) return 'none'
  const exec = resolvedEntry.get('Exec') ?? ''
  if (!execTargetsAppImage(exec, appImagePath)) return 'none'
  if (
    handlerId === DESKTOP_ENTRY_ID &&
    isOwnedBySelf(resolvedEntry, installId)
  ) {
    return 'self'
  }
  return 'external'
}

// A recorded previous / candidate handler is only worth capturing or restoring
// to if its desktop file is actually a launchable Application: present, not
// `Hidden`, of `Type=Application`, and carrying a non-empty `Exec`. Restoring a
// default to an empty/disabled/corrupt entry would just create a different dead
// default.
export function isUsableHandlerEntry(entry: Map<string, string>): boolean {
  return (
    entry.get('Type') === 'Application' &&
    entry.get('Hidden') !== 'true' &&
    (entry.get('Exec') ?? '').trim().length > 0
  )
}

// ── Injected ports ──────────────────────────────────────

export interface IntegrationStore {
  load(): Promise<IntegrationRecord>
  save(record: IntegrationRecord): Promise<void>
}

export interface IntegrationFs {
  writeText(filePath: string, data: string): Promise<void>
  readText(filePath: string): Promise<string>
  // Raw bytes, for content-fingerprinting the icon (which carries no marker).
  readBytes(filePath: string): Promise<Uint8Array>
  remove(filePath: string): Promise<void>
  mkdirp(dirPath: string): Promise<void>
  copyFile(src: string, dest: string): Promise<void>
}

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export type CommandRunner = (
  command: string,
  args: string[]
) => Promise<CommandResult>

export interface IntegrationLogger {
  info(obj: unknown, msg?: string): void
  warn(obj: unknown, msg?: string): void
  error(obj: unknown, msg?: string): void
}

export interface AppImageIntegrationDeps {
  appImagePath: string
  env: NodeJS.ProcessEnv
  homedir: string
  iconSourcePath: string
  store: IntegrationStore
  fs: IntegrationFs
  runCommand: CommandRunner
  getMagnetEnabled: () => boolean
  prompt: () => Promise<boolean>
  log: IntegrationLogger
}

// ── xdg helpers ─────────────────────────────────────────

// Full query result: `ok` distinguishes a successful lookup (even one that
// returns no handler) from a failed command (non-zero/timeout/missing binary).
// Callers that must fail safe on an uncertain state check `ok`.
async function queryDefaultHandlerResult(
  deps: AppImageIntegrationDeps,
  mime: string
): Promise<{ ok: boolean; id: string | null }> {
  try {
    const result = await deps.runCommand('xdg-mime', ['query', 'default', mime])
    if (result.code !== 0) return { ok: false, id: null }
    const id = result.stdout.trim()
    return { ok: true, id: id.length > 0 ? id : null }
  } catch (err) {
    deps.log.warn({ err, mime }, 'xdg-mime query default failed')
    return { ok: false, id: null }
  }
}

async function queryDefaultHandler(
  deps: AppImageIntegrationDeps,
  mime: string
): Promise<string | null> {
  return (await queryDefaultHandlerResult(deps, mime)).id
}

// Set a mime default and confirm it stuck by re-querying — never assume the
// handler is live just because the set command returned 0.
// Point `mime`'s default handler at `targetId` and confirm it stuck by
// re-querying — never assume the handler is live just because the set command
// returned 0. Shared by claiming our own entry and restoring a prior handler.
async function setDefaultAndVerify(
  deps: AppImageIntegrationDeps,
  mime: string,
  targetId: string
): Promise<boolean> {
  try {
    const set = await deps.runCommand('xdg-mime', ['default', targetId, mime])
    if (set.code !== 0) return false
  } catch (err) {
    deps.log.warn({ err, mime, targetId }, 'xdg-mime default failed')
    return false
  }
  const current = await queryDefaultHandler(deps, mime)
  return current === targetId
}

export interface MimeAppsEditResult {
  content: string
  changed: boolean
}

// Remove only one desktop id from one MIME key in [Default Applications].
// Other groups, comments, keys, and fallback handlers are preserved byte-for-
// byte except for the matching value line. This is the missing inverse of
// `xdg-mime default`, which intentionally has no `unset` verb.
export function removeDesktopIdFromMimeApps(
  content: string,
  mime: string,
  desktopId: string
): MimeAppsEditResult {
  const newline = content.includes('\r\n') ? '\r\n' : '\n'
  const hadTrailingNewline = content.endsWith('\n')
  const lines = content.split(/\r?\n/)
  if (hadTrailingNewline) lines.pop()

  let inDefaults = false
  let changed = false
  const next: string[] = []
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.startsWith('[') && line.endsWith(']')) {
      inDefaults = line === '[Default Applications]'
      next.push(rawLine)
      continue
    }
    if (!inDefaults || line === '' || line.startsWith('#')) {
      next.push(rawLine)
      continue
    }

    const eq = rawLine.indexOf('=')
    if (eq < 0 || rawLine.slice(0, eq).trim() !== mime) {
      next.push(rawLine)
      continue
    }
    const handlers = rawLine
      .slice(eq + 1)
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean)
    const remaining = handlers.filter((value) => value !== desktopId)
    if (remaining.length === handlers.length) {
      next.push(rawLine)
      continue
    }

    changed = true
    if (remaining.length > 0) {
      next.push(`${rawLine.slice(0, eq + 1)}${remaining.join(';')};`)
    }
  }

  return {
    content: `${next.join(newline)}${hadTrailingNewline ? newline : ''}`,
    changed,
  }
}

function userMimeAppsPaths(deps: AppImageIntegrationDeps): string[] {
  const configHome = resolveXdgConfigHome(deps.env, deps.homedir)
  const dataHome = resolveXdgDataHome(deps.env, deps.homedir)
  const desktopNames = (deps.env.XDG_CURRENT_DESKTOP ?? '')
    .split(':')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-z0-9_-]+$/.test(value))
  return [
    ...desktopNames.map((name) =>
      path.join(configHome, `${name}-mimeapps.list`)
    ),
    path.join(configHome, 'mimeapps.list'),
    ...desktopNames.map((name) =>
      path.join(applicationsDir(dataHome), `${name}-mimeapps.list`)
    ),
    path.join(applicationsDir(dataHome), 'mimeapps.list'),
  ].filter((value, index, all) => all.indexOf(value) === index)
}

async function clearOwnedDefaultAndVerify(
  deps: AppImageIntegrationDeps,
  mime: string
): Promise<boolean> {
  for (const filePath of userMimeAppsPaths(deps)) {
    let content: string
    try {
      content = await deps.fs.readText(filePath)
    } catch (err) {
      if (isEnoent(err)) continue
      deps.log.warn({ err, filePath, mime }, 'cannot read user mimeapps file')
      return false
    }
    const edit = removeDesktopIdFromMimeApps(content, mime, DESKTOP_ENTRY_ID)
    if (!edit.changed) continue
    try {
      await deps.fs.writeText(filePath, edit.content)
    } catch (err) {
      deps.log.warn({ err, filePath, mime }, 'cannot update user mimeapps file')
      return false
    }
  }

  const current = await queryDefaultHandlerResult(deps, mime)
  return current.ok && current.id !== DESKTOP_ENTRY_ID
}

async function updateDesktopDatabase(
  deps: AppImageIntegrationDeps,
  dataHome: string
): Promise<void> {
  try {
    await deps.runCommand('update-desktop-database', [
      applicationsDir(dataHome),
    ])
  } catch (err) {
    // Non-fatal: the entry is still valid, only its cache lookup lags.
    deps.log.warn({ err }, 'update-desktop-database failed')
  }
}

// Resolve a desktop id to its parsed entry by scanning the standard
// application directories, most-specific first.
async function resolveDesktopEntryById(
  deps: AppImageIntegrationDeps,
  dataHome: string,
  handlerId: string
): Promise<Map<string, string> | null> {
  // Never resolve an unsafe id: `path.join(dir, '../../x')` would escape the
  // applications directory. Safe ids are flat `*.desktop` basenames.
  if (!isSafeDesktopId(handlerId)) return null
  for (const dir of desktopSearchDirs(deps.env, dataHome)) {
    try {
      const content = await deps.fs.readText(path.join(dir, handlerId))
      return parseDesktopEntry(content)
    } catch {
      // try the next directory
    }
  }
  return null
}

// True only when `handlerId` resolves to a real, launchable Application entry —
// the guard used before recording it as a previous handler or restoring the
// default to it.
async function resolvesToUsableHandler(
  deps: AppImageIntegrationDeps,
  dataHome: string,
  handlerId: string
): Promise<boolean> {
  const entry = await resolveDesktopEntryById(deps, dataHome, handlerId)
  return entry !== null && isUsableHandlerEntry(entry)
}

function desktopSearchDirs(env: NodeJS.ProcessEnv, dataHome: string): string[] {
  const dirs = [applicationsDir(dataHome)]
  const dataDirs = env.XDG_DATA_DIRS?.split(':').filter(Boolean) ?? [
    '/usr/local/share',
    '/usr/share',
  ]
  for (const base of dataDirs) {
    if (path.isAbsolute(base)) dirs.push(path.join(base, 'applications'))
  }
  dirs.push(
    path.join(dataHome, 'flatpak', 'exports', 'share', 'applications'),
    '/var/lib/flatpak/exports/share/applications',
    '/var/lib/snapd/desktop/applications',
    '/app/share/applications'
  )
  return dirs.filter((value, index, all) => all.indexOf(value) === index)
}

function isEnoent(err: unknown): boolean {
  // Trust a structured errno code when present; only fall back to matching the
  // message for errors that carry no `code` (so an EACCES on a path that merely
  // contains the substring "ENOENT" is never mistaken for a missing file).
  if (err && typeof err === 'object' && 'code' in err) {
    return (err as { code?: unknown }).code === 'ENOENT'
  }
  return /ENOENT/.test(String((err as { message?: unknown })?.message ?? err))
}

// Read a file's bytes and hash them. `present` distinguishes a genuinely
// absent file (ENOENT → safe to create) from one that exists but cannot be
// read (any other error → must be treated as a foreign file we must not
// clobber), so a hash-mismatch and an unreadable file are never conflated.
async function readIconState(
  fs: IntegrationFs,
  filePath: string
): Promise<{ present: boolean; hash: string | null }> {
  try {
    return { present: true, hash: sha256Hex(await fs.readBytes(filePath)) }
  } catch (err) {
    if (isEnoent(err)) return { present: false, hash: null }
    return { present: true, hash: null }
  }
}

// ── Install / heal / remove transactions ────────────────

// Write the desktop file + icon and commit the URL-scheme defaults. Returns the
// next record. On any failure the record is marked `failed` so the next launch
// retries. Ordering is transactional per the design: (native-messaging host —
// Layer 3a TODO) → desktop file + icon → default commit.
async function installSelfIntegration(
  deps: AppImageIntegrationDeps,
  record: IntegrationRecord
): Promise<IntegrationRecord> {
  const dataHome = resolveXdgDataHome(deps.env, deps.homedir)

  // Reject a path that cannot be safely serialized (control chars / injection)
  // before touching anything. Nothing is written; the run fails closed.
  if (!isSafeAppImagePath(deps.appImagePath)) {
    deps.log.error(
      { appImagePath: JSON.stringify(deps.appImagePath) },
      'refusing to integrate: AppImage path contains control characters'
    )
    return { ...record, decision: 'accepted', owner: 'self', status: 'failed' }
  }

  // A stable per-install id, generated once and preserved across drift
  // rewrites, is our ownership proof (see IntegrationRecord.installId). A
  // tampered persisted record could hold an unsafe value (e.g. an embedded
  // newline), so regenerate unless the stored id is safe.
  const installId = isSafeInstallId(record.installId)
    ? record.installId
    : randomUUID()

  // Record the pre-existing defaults BEFORE overriding, so removal can restore
  // them — but only a handler that resolves to a real desktop file. A default
  // pointing at a non-existent id (e.g. one a prior Electron
  // setAsDefaultProtocolClient left behind) must NOT be recorded, or removal
  // would "restore" to a phantom and leave a dead default. `resolveDesktopEntryById`
  // also rejects unsafe ids. Only capture on first install.
  const capturePrevious = async (
    mime: string,
    current: string | null
  ): Promise<{ ok: boolean; value: string | null }> => {
    const q = await queryDefaultHandlerResult(deps, mime)
    // If we cannot even read the current default, do NOT proceed to overwrite
    // it — persisting `null` here would silently lose the user's real handler.
    if (!q.ok) return { ok: false, value: current }
    if (!q.id || q.id === DESKTOP_ENTRY_ID) return { ok: true, value: current }
    const usable = await resolvesToUsableHandler(deps, dataHome, q.id)
    return { ok: true, value: usable ? q.id : current }
  }
  // All captures are read-only queries on different mimes — run concurrently.
  // (The later set/restore calls that write the shared mimeapps.list stay
  // sequential.)
  const [schemeCap, torrentCap, magnetCap] = await Promise.all([
    capturePrevious(SCHEME_MIME, record.previousSchemeHandler),
    capturePrevious(TORRENT_MIME, record.previousTorrentHandler),
    capturePrevious(MAGNET_MIME, record.previousMagnetHandler),
  ])
  if (!schemeCap.ok || !torrentCap.ok || !magnetCap.ok) {
    deps.log.warn(
      {},
      'cannot query current default handlers; aborting to avoid losing them'
    )
    return {
      ...record,
      decision: 'accepted',
      owner: 'self',
      installId,
      status: 'failed',
    }
  }
  const previousSchemeHandler = schemeCap.value
  const previousTorrentHandler = torrentCap.value
  const previousMagnetHandler = magnetCap.value

  const base: IntegrationRecord = {
    ...record,
    decision: 'accepted',
    owner: 'self',
    desktopId: DESKTOP_ENTRY_ID,
    installId,
    previousSchemeHandler,
    previousTorrentHandler,
    previousMagnetHandler,
  }

  // Persist installId + captured previous handlers BEFORE writing any file or
  // mutating any default. A crash between here and the final save must not (a)
  // orphan our own file (next launch would see `installId === null`, judge its
  // own leftover a foreign conflict, and never repair it), nor (b) lose the
  // user's original default handlers after we have started overriding them.
  const failed: IntegrationRecord = { ...base, status: 'failed' }
  if (
    record.installId !== installId ||
    record.previousSchemeHandler !== previousSchemeHandler ||
    record.previousTorrentHandler !== previousTorrentHandler ||
    record.previousMagnetHandler !== previousMagnetHandler
  ) {
    await deps.store.save(failed)
  }

  const desktopPath = desktopEntryFilePath(dataHome)
  const icon = iconFilePath(dataHome)

  // No-clobber: if a file already sits at our desktop path and it is NOT ours
  // (missing/mismatched id), it belongs to someone else (another AppImage
  // install, a user file) — never overwrite it. `drift` (our own file, stale
  // Exec) and a missing file are both safe to (re)write.
  let existing: string | null = null
  try {
    existing = await deps.fs.readText(desktopPath)
  } catch (err) {
    // Only a genuinely absent file (ENOENT) is safe to create. A file that
    // exists but cannot be read is a foreign file we must not clobber.
    if (!isEnoent(err)) {
      deps.log.warn(
        { desktopPath },
        'existing desktop file is unreadable; not overwriting'
      )
      return failed
    }
    existing = null
  }
  if (existing !== null) {
    const decision = classifyDesktopFile(existing, deps.appImagePath, installId)
    if (decision === 'conflict') {
      deps.log.warn(
        { desktopPath },
        'appimage desktop path occupied by a foreign file; not overwriting'
      )
      return failed
    }
  }

  let iconSha256: string | null = record.iconSha256
  try {
    // TODO(Layer 3a): when `record.nmConsent === 'accepted'`, copy the native
    // host to a stable path and sync its NM manifests here, before the desktop
    // file, so the transaction unwinds NM last. Not implemented in Layer 2.

    await deps.fs.mkdirp(applicationsDir(dataHome))
    await deps.fs.writeText(
      desktopPath,
      buildDesktopEntry({ appImagePath: deps.appImagePath, installId })
    )
    await deps.fs.mkdirp(path.dirname(icon))
    const iconBytes = await deps.fs.readBytes(deps.iconSourcePath)
    const sourceHash = sha256Hex(iconBytes)
    // No-clobber for the icon too: an icon carries no marker, so only overwrite
    // when the target is genuinely absent, is our own recorded icon, or is
    // byte-identical to what we would write. A foreign icon squatting our
    // (unique) name — including one that exists but cannot be read — is left
    // untouched.
    const existingIcon = await readIconState(deps.fs, icon)
    const iconIsOursOrAbsent =
      !existingIcon.present ||
      (existingIcon.hash !== null &&
        (existingIcon.hash === record.iconSha256 ||
          existingIcon.hash === sourceHash))
    if (iconIsOursOrAbsent) {
      await deps.fs.copyFile(deps.iconSourcePath, icon)
      iconSha256 = sourceHash
    } else {
      deps.log.warn(
        { icon },
        'appimage icon path occupied by a foreign file; not overwriting'
      )
    }
  } catch (err) {
    deps.log.error({ err }, 'failed to write appimage desktop file or icon')
    return failed
  }

  await updateDesktopDatabase(deps, dataHome)

  const schemeOk = await setDefaultAndVerify(
    deps,
    SCHEME_MIME,
    DESKTOP_ENTRY_ID
  )
  const torrentOk = await setDefaultAndVerify(
    deps,
    TORRENT_MIME,
    DESKTOP_ENTRY_ID
  )
  // Mirror protocol-manager: only claim the magnet default when the setting is
  // on; otherwise leave whatever the user already had.
  let magnetOk = true
  if (deps.getMagnetEnabled()) {
    magnetOk = await setDefaultAndVerify(deps, MAGNET_MIME, DESKTOP_ENTRY_ID)
  } else {
    magnetOk = await restoreDefault(deps, MAGNET_MIME, previousMagnetHandler)
  }

  const status: IntegrationStatus =
    schemeOk && torrentOk && magnetOk ? 'healthy' : 'failed'
  if (status === 'failed') {
    deps.log.warn(
      { schemeOk, torrentOk, magnetOk },
      'appimage default handler verification failed'
    )
  }
  return { ...base, status, iconSha256 }
}

// Bring the magnet default in line with the current setting: claim it when
// enabled and not already ours; hand it back to the recorded prior handler
// when disabled and currently ours. Returns the record, updated if a new
// previous handler was captured (so a later revert restores the handler the
// user was actually using, not a stale one). A failed mutation marks the
// integration failed so settings never claim a preference was applied.
async function reconcileMagnetDefault(
  deps: AppImageIntegrationDeps,
  record: IntegrationRecord
): Promise<IntegrationRecord> {
  const q = await queryDefaultHandlerResult(deps, MAGNET_MIME)
  if (!q.ok) return { ...record, status: 'failed' }
  if (deps.getMagnetEnabled()) {
    if (q.id === DESKTOP_ENTRY_ID) return record
    // About to overwrite whatever is currently the magnet handler — capture it
    // as the new previous (if it is a real, resolvable handler) so a later
    // revert goes back to it rather than an older recorded value.
    let next = record
    if (q.id && q.id !== record.previousMagnetHandler) {
      const dataHome = resolveXdgDataHome(deps.env, deps.homedir)
      if (await resolvesToUsableHandler(deps, dataHome, q.id)) {
        next = { ...record, previousMagnetHandler: q.id }
        // Persist the new previous BEFORE overriding the default, so a crash
        // (or a failed save) after the override cannot leave us pointing at
        // ourselves with a stale recorded previous.
        await deps.store.save(next)
      }
    }
    const applied = await setDefaultAndVerify(
      deps,
      MAGNET_MIME,
      DESKTOP_ENTRY_ID
    )
    return applied ? next : { ...next, status: 'failed' }
  }
  if (q.id === DESKTOP_ENTRY_ID) {
    const restored = await restoreDefault(
      deps,
      MAGNET_MIME,
      record.previousMagnetHandler
    )
    if (!restored) return { ...record, status: 'failed' }
  }
  return record
}

// Startup maintenance for an already-accepted self integration: silently repair
// drift (updated/moved AppImage) and retry a prior failure. Never overwrites a
// foreign file that has taken our desktop path (ownership conflict).
async function selfHeal(
  deps: AppImageIntegrationDeps,
  record: IntegrationRecord
): Promise<IntegrationRecord> {
  if (record.status === 'failed') {
    return installSelfIntegration(deps, record)
  }

  const dataHome = resolveXdgDataHome(deps.env, deps.homedir)
  const desktopPath = desktopEntryFilePath(dataHome)
  let content: string | null = null
  try {
    content = await deps.fs.readText(desktopPath)
  } catch {
    content = null
  }

  if (content === null) {
    deps.log.info(
      { desktopPath },
      'appimage desktop file missing; reinstalling'
    )
    return installSelfIntegration(deps, record)
  }

  const decision = classifyDesktopFile(
    content,
    deps.appImagePath,
    record.installId
  )
  if (decision === 'ok') {
    // In an AppImage the settings-change path (protocolManager.register) is a
    // no-op, so this startup pass is the only place a magnet-setting toggle
    // converges. TODO(follow-up): also reconcile immediately when the setting
    // changes at runtime, once a settings-change hook is wired here.
    const reconciled = await reconcileMagnetDefault(deps, record)
    if (reconciled !== record) await deps.store.save(reconciled)
    return reconciled
  }
  if (decision === 'drift') {
    deps.log.info({ desktopPath }, 'repairing drifted appimage desktop file')
    return installSelfIntegration(deps, record)
  }
  // conflict: a foreign file occupies our path. Do not overwrite; mark failed
  // so the state is visible in settings and re-checked next launch.
  deps.log.warn(
    { desktopPath },
    'appimage desktop path occupied by a foreign file; leaving it untouched'
  )
  const next: IntegrationRecord = { ...record, status: 'failed' }
  return next
}

// Read-only status validation for the settings query. Persisted `healthy` is
// only trusted while the owned entry/icon still match and all required
// defaults reflect the current preference. A previous failed transaction is
// never silently upgraded here; retry remains an explicit enable/startup step.
export async function inspectSystemIntegration(
  deps: AppImageIntegrationDeps
): Promise<IntegrationRecord> {
  const record = await deps.store.load()
  if (
    record.decision !== 'accepted' ||
    record.owner !== 'self' ||
    record.status !== 'healthy'
  ) {
    return record
  }

  const dataHome = resolveXdgDataHome(deps.env, deps.homedir)
  let desktopOk = false
  let iconOk = false
  try {
    const content = await deps.fs.readText(desktopEntryFilePath(dataHome))
    desktopOk =
      classifyDesktopFile(content, deps.appImagePath, record.installId) === 'ok'
  } catch {
    desktopOk = false
  }
  if (record.iconSha256) {
    try {
      iconOk =
        sha256Hex(await deps.fs.readBytes(iconFilePath(dataHome))) ===
        record.iconSha256
    } catch {
      iconOk = false
    }
  }

  const [scheme, torrent, magnet] = await Promise.all([
    queryDefaultHandlerResult(deps, SCHEME_MIME),
    queryDefaultHandlerResult(deps, TORRENT_MIME),
    queryDefaultHandlerResult(deps, MAGNET_MIME),
  ])
  const defaultsOk =
    scheme.ok &&
    scheme.id === DESKTOP_ENTRY_ID &&
    torrent.ok &&
    torrent.id === DESKTOP_ENTRY_ID &&
    magnet.ok &&
    (deps.getMagnetEnabled()
      ? magnet.id === DESKTOP_ENTRY_ID
      : magnet.id !== DESKTOP_ENTRY_ID)

  return desktopOk && iconOk && defaultsOk
    ? record
    : { ...record, status: 'failed' }
}

// Reverse-order teardown driven from the settings page. NM removal is a Layer 3a
// TODO. Restores the recorded defaults FIRST and only deletes our files if the
// restore succeeded — otherwise a deleted desktop would leave a dangling
// default handler behind.
export async function removeSystemIntegration(
  deps: AppImageIntegrationDeps
): Promise<IntegrationRecord> {
  const record = await deps.store.load()
  // An externally-owned integration (deb install, another tool) was never
  // written by us: there is nothing of ours to delete, and flipping the record
  // to `declined` would erase the external classification. Leave both alone.
  if (record.owner === 'external') {
    deps.log.info(
      {},
      'appimage integration is externally owned; nothing to remove'
    )
    return record
  }
  const dataHome = resolveXdgDataHome(deps.env, deps.homedir)
  const desktopPath = desktopEntryFilePath(dataHome)
  const icon = iconFilePath(dataHome)

  // TODO(Layer 3a): unregister native-messaging manifests / remove the stable
  // host copy first, mirroring the install order in reverse.

  const schemeRestored = await restoreDefault(
    deps,
    SCHEME_MIME,
    record.previousSchemeHandler
  )
  const torrentRestored = await restoreDefault(
    deps,
    TORRENT_MIME,
    record.previousTorrentHandler
  )
  const magnetRestored = await restoreDefault(
    deps,
    MAGNET_MIME,
    record.previousMagnetHandler
  )
  if (!schemeRestored || !torrentRestored || !magnetRestored) {
    // Could not safely reclaim the defaults — keep the desktop file so the
    // default is not left pointing at a deleted entry. Persist `failed` for a
    // later retry from settings.
    deps.log.warn(
      { schemeRestored, torrentRestored, magnetRestored },
      'aborting appimage removal: could not restore mime defaults'
    )
    const stuck: IntegrationRecord = { ...record, status: 'failed' }
    await deps.store.save(stuck)
    return stuck
  }

  // Delete the desktop file only if it is still verifiably ours.
  try {
    const content = await deps.fs.readText(desktopPath)
    if (isOwnedBySelf(parseDesktopEntry(content), record.installId)) {
      await deps.fs.remove(desktopPath)
    }
  } catch {
    // already gone
  }
  // Delete the icon only if its bytes still match what we installed (an icon
  // carries no marker, so this is its ownership check).
  if (record.iconSha256) {
    try {
      const bytes = await deps.fs.readBytes(icon)
      if (sha256Hex(bytes) === record.iconSha256) {
        await deps.fs.remove(icon)
      }
    } catch {
      // already gone / unreadable
    }
  }
  await updateDesktopDatabase(deps, dataHome)

  const next: IntegrationRecord = {
    ...DEFAULT_INTEGRATION_RECORD,
    decision: 'declined',
  }
  await deps.store.save(next)
  return next
}

// Restore a previously-recorded default handler. Returns whether the mime is
// now in a safe state (either no longer ours, or successfully repointed and
// re-verified). Returns false — blocking desktop deletion — when the default is
// still ours but we cannot safely reclaim it (the owned mimeapps entry could
// not be cleared, the previous id is unsafe, or set/verify failed).
async function restoreDefault(
  deps: AppImageIntegrationDeps,
  mime: string,
  previous: string | null
): Promise<boolean> {
  const query = await queryDefaultHandlerResult(deps, mime)
  // If we cannot even read the current default (command missing / timeout /
  // non-zero), we do not know whether it still points at us — fail safe and
  // block deletion rather than risk leaving a default pointing at a file we
  // are about to remove.
  if (!query.ok) return false
  if (query.id !== DESKTOP_ENTRY_ID) return true // user re-pointed it; nothing to do
  if (!previous) return clearOwnedDefaultAndVerify(deps, mime)
  if (!isSafeDesktopId(previous)) {
    deps.log.warn({ mime, previous }, 'recorded previous handler is unsafe')
    return false
  }
  // The recorded handler may have been uninstalled, disabled, or corrupted
  // since we captured it. Restoring the default to a missing OR non-launchable
  // entry would just create a different dead default, so fail safe (block
  // deletion, keep our own file).
  const dataHome = resolveXdgDataHome(deps.env, deps.homedir)
  if (!(await resolvesToUsableHandler(deps, dataHome, previous))) {
    deps.log.warn(
      { mime, previous },
      'recorded previous handler is missing or not launchable; not restoring'
    )
    return false
  }
  return setDefaultAndVerify(deps, mime, previous)
}

// ── Entry points ────────────────────────────────────────

export async function runStartupIntegration(
  deps: AppImageIntegrationDeps
): Promise<IntegrationRecord> {
  const record = await deps.store.load()

  if (record.decision === 'declined') return record

  if (record.decision === 'accepted') {
    if (record.owner === 'external') {
      // Re-verify the external owner every startup — it may have been deleted,
      // disabled, or repointed since we recorded it. A stale `external` must
      // not linger as a false `healthy`.
      const stillExternal = await detectExternalOwner(deps, record.installId)
      if (stillExternal) {
        if (stillExternal === record.desktopId) return record
        const moved: IntegrationRecord = { ...record, desktopId: stillExternal }
        await deps.store.save(moved)
        return moved
      }
      // External integration is gone — reset to first-run detection/prompt.
      deps.log.info(
        { previous: record.desktopId },
        'external appimage integration no longer present; re-detecting'
      )
      const reset: IntegrationRecord = {
        ...record,
        decision: 'unset',
        owner: null,
        desktopId: null,
        status: null,
      }
      return runFirstRun(deps, reset)
    }
    if (record.owner === 'self') {
      const next = await selfHeal(deps, record)
      if (next !== record) await deps.store.save(next)
      return next
    }
    return record
  }

  // decision === 'unset' — first run.
  return runFirstRun(deps, record)
}

// First-run detection + consent. Detect a pre-existing external owner before
// prompting; otherwise ask and, on acceptance, install.
async function runFirstRun(
  deps: AppImageIntegrationDeps,
  record: IntegrationRecord
): Promise<IntegrationRecord> {
  const external = await detectExternalOwner(deps, record.installId)
  if (external) {
    const next: IntegrationRecord = {
      ...record,
      decision: 'accepted',
      owner: 'external',
      desktopId: external,
      status: 'healthy',
    }
    await deps.store.save(next)
    return next
  }

  const accepted = await deps.prompt()
  if (!accepted) {
    const declined: IntegrationRecord = { ...record, decision: 'declined' }
    await deps.store.save(declined)
    return declined
  }

  const installed = await installSelfIntegration(deps, record)
  await deps.store.save(installed)
  return installed
}

async function detectExternalOwner(
  deps: AppImageIntegrationDeps,
  installId: string | null
): Promise<string | null> {
  const handlerId = await queryDefaultHandler(deps, SCHEME_MIME)
  if (!handlerId) return null
  const dataHome = resolveXdgDataHome(deps.env, deps.homedir)
  const resolvedEntry = await resolveDesktopEntryById(deps, dataHome, handlerId)
  const owner = classifyDefaultHandler({
    handlerId,
    resolvedEntry,
    appImagePath: deps.appImagePath,
    installId,
  })
  return owner === 'external' ? handlerId : null
}

// Manual "enable system integration" entry point from settings. Runs the full
// install transaction regardless of the prior decision (including `declined`).
export async function enableSystemIntegration(
  deps: AppImageIntegrationDeps
): Promise<IntegrationRecord> {
  const record = await deps.store.load()
  const installed = await installSelfIntegration(deps, record)
  await deps.store.save(installed)
  return installed
}
