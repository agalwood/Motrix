import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeDownloadSource } from '@shared/lib/download-source'
import { projectTorrentMeta } from '@shared/lib/torrent-meta'
import type { LegacyImportItem } from '@shared/schemas/legacy-import'
import type { TorrentMeta } from '@shared/types/torrent'
import parseTorrent from 'parse-torrent'
import { parseBtFileLayout } from '../task/bt-storage-layout'
import {
  digestBytes,
  type LegacySessionEntry,
  MAX_LEGACY_BYTES,
  parseLegacySession,
  safeLegacyComponent,
  safeLegacyDirectory,
  safeLegacyOutput,
  validateLegacyBencode,
} from './session-parser'

export interface LegacySource {
  root: string
  identity: string
}
export interface LegacySnapshotFile {
  relativePath: string
  bytes: Buffer
  digest: string
  identity?: string
}
/** An exact user-selected file; it never authorizes other files in its parent. */
export interface LegacyTorrentGrant {
  source: LegacySource
  relativePath: string
  identity: string
  digest: string
  referencePath: string
}
export interface LegacyCandidate {
  item: LegacyImportItem
  entry: LegacySessionEntry
  outputPath: string | null
  torrent: TorrentMeta | null
  torrentRelativePath: string | null
  torrentReferencePath?: string
  selectedFiles: number[]
  selectionKnown: boolean
  trackers: string[][]
}
export interface LegacySnapshot {
  source: LegacySource
  sourceId: string
  digest: string
  files: LegacySnapshotFile[]
  candidates: LegacyCandidate[]
  running: boolean
}

export async function authorizeLegacySource(
  selectedRoot: string
): Promise<LegacySource> {
  const root = await realpath(selectedRoot)
  const stat = await lstat(root)
  if (!stat.isDirectory()) throw new Error('legacyImport.invalidSource')
  return { root, identity: `${stat.dev}:${stat.ino}` }
}

/** Fixed metadata reads only; payloads and control files outside this grant are never opened. */
export async function readLegacyFile(
  source: LegacySource,
  relativePath: string,
  optional = false
): Promise<LegacySnapshotFile | null> {
  const parts = relativePath.split(/[\\/]/)
  if (
    path.isAbsolute(relativePath) ||
    parts.some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('legacyImport.unsafeSource')
  const root = await lstat(source.root)
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    `${root.dev}:${root.ino}` !== source.identity
  )
    throw new Error('legacyImport.changedSource')
  let candidatePath = source.root
  try {
    for (const part of parts.slice(0, -1)) {
      candidatePath = path.join(candidatePath, part)
      const stat = await lstat(candidatePath)
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('legacyImport.unsafeSource')
    }
    const filename = path.join(source.root, ...parts)
    const before = await lstat(filename)
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > MAX_LEGACY_BYTES
    )
      throw new Error('legacyImport.unsafeSource')
    const handle = await open(
      filename,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    )
    try {
      const opened = await handle.stat()
      if (
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.nlink !== 1 ||
        !opened.isFile() ||
        opened.size > MAX_LEGACY_BYTES
      )
        throw new Error('legacyImport.changedSource')
      const bytes = Buffer.alloc(opened.size + 1)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      const after = await handle.stat()
      if (
        bytesRead !== opened.size ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs
      )
        throw new Error('legacyImport.changedSource')
      const content = bytes.subarray(0, bytesRead)
      return {
        relativePath,
        bytes: content,
        digest: digestBytes(content),
        identity: `${opened.dev}:${opened.ino}`,
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return null
    throw error
  }
}

export async function authorizeLegacyTorrent(
  selectedFile: string,
  referencePath: string
): Promise<LegacyTorrentGrant> {
  const selected = path.resolve(selectedFile)
  const before = await lstat(selected)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new Error('legacyImport.unsafeSource')
  const canonical = await realpath(selected)
  const source = await authorizeLegacySource(path.dirname(canonical))
  const relativePath = path.basename(canonical)
  const file = await readLegacyFile(source, relativePath)
  if (!file || file.identity !== `${before.dev}:${before.ino}`)
    throw new Error('legacyImport.changedSource')
  try {
    validateLegacyBencode(file.bytes)
    const parsed = await parseTorrent(new Uint8Array(file.bytes))
    const torrent = projectTorrentMeta(parsed)
    await parseBtFileLayout(file.bytes)
    if (
      !torrent.files.length ||
      torrent.files.length > 10000 ||
      !safeLegacyComponent(torrent.name)
    )
      throw new Error('invalid')
  } catch {
    throw new Error('legacyImport.metadataMismatch')
  }
  const expected = /^([a-f\d]{40})\.torrent$/i.exec(
    path.basename(referencePath)
  )
  if (expected) {
    if (
      createHash('sha1').update(file.bytes).digest('hex') !==
      expected[1].toLowerCase()
    )
      throw new Error('legacyImport.metadataMismatch')
  } else if (canonical !== path.resolve(referencePath)) {
    // A human filename has no durable content identifier. Only the exact
    // referenced file can be explicitly authorized; arbitrary replacements
    // cannot be proved to describe the old task.
    throw new Error('legacyImport.metadataMismatch')
  }
  return {
    source,
    relativePath,
    identity: file.identity,
    digest: file.digest,
    referencePath,
  }
}

export async function isLegacyTorrentGrantValid(
  grant: LegacyTorrentGrant
): Promise<boolean> {
  try {
    const file = await readLegacyFile(grant.source, grant.relativePath)
    return file?.identity === grant.identity && file.digest === grant.digest
  } catch {
    return false
  }
}

async function readGrantedTorrent(
  grant: LegacyTorrentGrant,
  entryDigest: string,
  referencePath: string
): Promise<LegacySnapshotFile> {
  if (grant.referencePath !== referencePath)
    throw new Error('legacyImport.changedSource')
  const file = await readLegacyFile(grant.source, grant.relativePath)
  if (!file || file.identity !== grant.identity || file.digest !== grant.digest)
    throw new Error('legacyImport.changedSource')
  return { ...file, relativePath: `authorized-torrents/${entryDigest}.torrent` }
}

function parseObject(file: LegacySnapshotFile): Record<string, unknown> {
  const value: unknown = JSON.parse(file.bytes.toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('legacyImport.invalidSource')
  return value as Record<string, unknown>
}

function selection(
  value: string | undefined,
  count: number
): { files: number[]; known: boolean } {
  if (!value) return { files: [], known: false }
  const result = new Set<number>()
  for (const range of value.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(range)
    if (!match) throw new Error('legacyImport.invalidSource')
    const start = Number(match[1])
    const end = Number(match[2] ?? match[1])
    if (start < 1 || end < start || end > count || end - start > 10000)
      throw new Error('legacyImport.invalidSource')
    for (let index = start; index <= end; index++) result.add(index - 1)
  }
  return { files: [...result].sort((a, b) => a - b), known: true }
}

export async function scanLegacySource(
  source: LegacySource,
  isProcessRunning: (pid: number) => boolean | Promise<boolean>,
  torrentGrants: ReadonlyMap<string, LegacyTorrentGrant> = new Map()
): Promise<LegacySnapshot> {
  const files: LegacySnapshotFile[] = []
  const required = async (name: string) => {
    const file = await readLegacyFile(source, name)
    if (!file) throw new Error('legacyImport.invalidSource')
    files.push(file)
    return file
  }
  const user = parseObject(await required('user.json'))
  const system = parseObject(await required('system.json'))
  if (
    typeof system.dir !== 'string' ||
    !('theme' in user || 'locale' in user || 'auto-resume-all' in user)
  )
    throw new Error('legacyImport.invalidSource')
  const session = await required('download.session')
  const pidFile = await readLegacyFile(source, 'engine.pid', true)
  if (pidFile) files.push(pidFile)
  const pid = pidFile ? Number(pidFile.bytes.toString('utf8').trim()) : null
  const running =
    pid !== null &&
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    (await isProcessRunning(pid))
  const candidates: LegacyCandidate[] = []
  let snapshotBytes = files.reduce((sum, file) => sum + file.bytes.length, 0)
  const torrentByPath = new Map<string, LegacySnapshotFile>()
  for (const entry of parseLegacySession(session.bytes)) {
    const item: LegacyImportItem = {
      itemId: entry.itemKey,
      name: entry.options.out || '—',
      saveDir: safeLegacyDirectory(entry.options.dir ?? (system.dir as string)),
      type: 'unknown',
      selectable: true,
      reason: 'fresh-download-required',
    }
    const candidate: LegacyCandidate = {
      item,
      entry,
      outputPath: null,
      torrent: null,
      torrentRelativePath: null,
      selectedFiles: [],
      selectionKnown: false,
      trackers: [],
    }
    candidates.push(candidate)
    try {
      if (entry.reason) {
        item.selectable = false
        item.reason = entry.reason
        continue
      }
      const first = entry.uris[0]
      if (!first) throw new Error('invalid')
      const dir = entry.options.dir ?? (system.dir as string)
      if (first.startsWith('magnet:?')) {
        const analysis = analyzeDownloadSource(first)
        if (
          entry.uris.length !== 1 ||
          analysis.status !== 'accepted' ||
          analysis.protocol !== 'magnet'
        )
          throw new Error('invalid')
        item.type = 'magnet'
        const url = new URL(first)
        item.name = entry.options.out || url.searchParams.get('dn') || 'Magnet'
        candidate.outputPath = safeLegacyOutput(dir, item.name)
        item.reason = 'metadata-required'
      } else if (/^https?:\/\//i.test(first)) {
        if (
          entry.uris.some((uri) => {
            const analysis = analyzeDownloadSource(uri)
            return (
              analysis.status !== 'accepted' ||
              !['http', 'https'].includes(analysis.protocol) ||
              Boolean(new URL(uri).username || new URL(uri).password)
            )
          })
        )
          throw new Error('invalid')
        if (
          [
            'header',
            'http-user',
            'http-passwd',
            'all-proxy-user',
            'all-proxy-passwd',
            'http-proxy',
            'http-proxy-user',
            'http-proxy-passwd',
            'https-proxy',
            'https-proxy-user',
            'https-proxy-passwd',
            'load-cookies',
            'referer',
            'all-proxy',
          ].some(
            (key) =>
              system[key] !== undefined &&
              system[key] !== null &&
              system[key] !== '' &&
              (!Array.isArray(system[key]) ||
                (system[key] as unknown[]).length !== 0)
          )
        ) {
          item.selectable = false
          item.reason = 'unsupported-options'
          continue
        }
        item.type = 'http'
        item.name =
          entry.options.out ||
          decodeURIComponent(
            new URL(first).pathname.split('/').at(-1) || 'download'
          )
        candidate.outputPath = safeLegacyOutput(dir, item.name)
        item.reason = 'fresh-download-required'
      } else {
        const filename = first.startsWith('file:')
          ? fileURLToPath(first)
          : first
        const resolved = path.isAbsolute(filename)
          ? path.resolve(filename)
          : path.resolve(source.root, filename)
        candidate.torrentReferencePath = resolved
        let relative = path.relative(source.root, resolved)
        if (entry.uris.length !== 1 || !relative.endsWith('.torrent'))
          throw new Error('unsafe')
        const outsideGrant =
          !relative || relative.startsWith('..') || path.isAbsolute(relative)
        const explicitGrant = torrentGrants.get(entry.digest)
        if (outsideGrant && !explicitGrant) {
          // The session often references RPC-saved metadata in the user's
          // separate downloads directory. That path does not grant access.
          item.type = 'bt'
          item.name = entry.options.out || path.basename(filename)
          item.selectable = false
          item.reason = 'metadata-required'
          continue
        }
        let file = torrentByPath.get(relative)
        if (!file) {
          file = explicitGrant
            ? await readGrantedTorrent(explicitGrant, entry.digest, resolved)
            : ((await readLegacyFile(source, relative)) ?? undefined)
          if (!file) throw new Error('invalid')
          relative = file.relativePath
          snapshotBytes += file.bytes.length
          if (snapshotBytes > 64 * 1024 * 1024)
            throw new Error('legacyImport.tooLarge')
          files.push(file)
          torrentByPath.set(relative, file)
        }
        validateLegacyBencode(file.bytes)
        const parsed = await parseTorrent(new Uint8Array(file.bytes))
        const torrent = projectTorrentMeta(parsed)
        await parseBtFileLayout(file.bytes)
        if (
          torrent.files.length < 1 ||
          torrent.files.length > 10000 ||
          !safeLegacyComponent(torrent.name) ||
          !Number.isSafeInteger(torrent.totalSize)
        )
          throw new Error('unsafe')
        const selected = selection(
          entry.options['select-file'],
          torrent.files.length
        )
        candidate.torrent = torrent
        candidate.torrentRelativePath = relative
        candidate.selectedFiles = selected.files
        candidate.selectionKnown = selected.known
        const additionalTrackers = entry.optionPairs
          .filter(([key]) => key === 'bt-tracker')
          .flatMap(([, value]) => value.split(',').filter(Boolean))
        candidate.trackers = [
          ...new Set([...(parsed.announce ?? []), ...additionalTrackers]),
        ].map((tracker) => [tracker])
        item.type = 'bt'
        item.name = entry.options.out || torrent.name
        candidate.outputPath = safeLegacyOutput(dir, item.name)
        item.reason = selected.known
          ? 'verification-required'
          : 'selection-required'
      }
      if (!candidate.outputPath) {
        item.reason = 'unsafe-path'
        item.selectable = false
      }
      if (!entry.gid && candidate.outputPath) {
        // Pause, limits, selection and other mutable session options are not
        // task identity. Keep deletion tombstones stable across ordinary saves.
        const content =
          candidate.torrent?.infoHash ??
          (item.type === 'magnet'
            ? new URL(first).searchParams
                .getAll('xt')
                .map((value) => value.toLowerCase())
                .sort()
            : [...entry.uris].sort())
        entry.itemKey = `entry:${digestBytes(JSON.stringify([item.type, candidate.outputPath, content]))}`
        if (!torrentGrants.has(entry.digest)) item.itemId = entry.itemKey
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'legacyImport.tooLarge')
        throw error
      if (torrentGrants.has(entry.digest))
        throw new Error('legacyImport.changedSource')
      item.reason = 'invalid-record'
      item.selectable = false
    }
  }
  const groups = new Map<string, LegacyCandidate[]>()
  for (const candidate of candidates) {
    const group = groups.get(candidate.entry.itemKey) ?? []
    group.push(candidate)
    groups.set(candidate.entry.itemKey, group)
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    group.forEach((candidate, index) => {
      candidate.item.selectable = false
      candidate.item.reason = 'invalid-record'
      candidate.item.itemId = `${candidate.entry.itemKey}:duplicate:${index}`
    })
  }
  const sourceId = digestBytes(`${source.root}\0${source.identity}`)
  const digest = digestBytes(
    files
      .map(
        (file) => `${file.relativePath}\0${file.digest}\0${file.identity ?? ''}`
      )
      .sort()
      .join('\n')
  )
  return { source, sourceId, digest, files, candidates, running }
}
