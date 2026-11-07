import { lstat, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  type ArtifactIdentity,
  ArtifactIdentityCache,
  artifactIdentityEquals,
  readArtifactIdentity,
} from '@core/plugin/finalize/artifact-identity'
import type { MotrixDatabase } from '@core/session/motrix-database'
import { verifyBtFiles } from '@core/task/bt-file-verifier'
import {
  getBtDirectStorageLayout,
  parseBtFileLayout,
} from '@core/task/bt-storage-layout'
import { isTempPath } from '@core/task/paths'
import { restoreTaskSaveDirectory } from '@core/task/task-save-directory'
import { type DownloadTask, TaskStatus, TaskType } from '@shared/types/task'
import type { ServerDownloadPathPolicy } from '../../download-path-policy'

const fileStamp = (info: {
  dev: bigint
  ino: bigint
  birthtimeNs: bigint
  size: bigint
  mtimeNs: bigint
  isDirectory(): boolean
}) =>
  info.isDirectory()
    ? `${fileId(info)}:${info.birthtimeNs}`
    : `${fileId(info)}:${info.birthtimeNs}:${info.size}:${info.mtimeNs}`
const fileId = (info: { dev: bigint; ino: bigint }) => `${info.dev}:${info.ino}`
type PathClaim = {
  identity: string
  stamp: string
  tree: string | null
  journal: string | null
}
type Published = { journal: string; artifact: string | null }
type Tree = Record<string, string>

async function existing(file: string) {
  return lstat(file, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
}

function inside(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
    ? relative
    : null
}

// Only inspect the torrent's own paths. A neighbour can add unrelated files
// to a shared directory at any time.
async function snapshotMembers(root: string, paths: readonly string[]) {
  const entries: Tree = Object.create(null)
  const names = new Set<string>()
  for (const candidate of paths) {
    let relative = inside(root, candidate)
    while (relative && relative !== '.') {
      names.add(relative)
      relative = path.dirname(relative)
    }
  }
  for (const name of [...names].sort()) {
    const file = path.join(root, name)
    const info = await existing(file)
    if (!info) continue
    if (
      (!info.isFile() && !info.isDirectory()) ||
      (await realpath(file)) !== file
    )
      throw Error('Unsafe entry in task directory')
    entries[name] = fileStamp(info)
  }
  return entries
}

async function verifyMembers(root: string, allowed: Tree, relative = '') {
  for (const name of await readdir(path.join(root, relative))) {
    const child = path.join(relative, name)
    if (!Object.hasOwn(allowed, child))
      throw Error('Untracked file in task directory')
    const file = path.join(root, child)
    const info = await lstat(file, { bigint: true })
    if (
      (!info.isFile() && !info.isDirectory()) ||
      fileStamp(info) !== allowed[child] ||
      (await realpath(file)) !== file
    )
      throw Error('Task directory contains a different file')
    if (info.isDirectory()) await verifyMembers(root, allowed, child)
  }
}

/** Path grants cover the share. These private claims tie a task to the
 * directory it was admitted into and to the artifact actually published. */
export class SynologyTaskFiles {
  private readonly digests = new ArtifactIdentityCache()
  constructor(
    private readonly db: Pick<MotrixDatabase, 'database' | 'getAllTasks'>,
    private readonly policy: ServerDownloadPathPolicy
  ) {}

  async initialize() {
    const sql = this.db.database
    if (
      sql
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='synology_task_paths'"
        )
        .get()
    )
      return
    // An old task has no historical directory identity. Bind only available,
    // authorized locations once. Never adopt a file during read or deletion.
    const legacy: [string, string, string][] = []
    const directories = new Map<string, string | null>()
    for (const { task, instances } of this.db.getAllTasks()) {
      const dir = restoreTaskSaveDirectory(task, instances)
      if (!directories.has(dir))
        directories.set(dir, await this.directoryId(dir).catch(() => null))
      const id = directories.get(dir)
      if (id) legacy.push([task.motrixId, dir, id])
    }
    sql.transaction(() => {
      sql.exec(`CREATE TABLE synology_task_paths (
        task_id TEXT NOT NULL REFERENCES tasks(motrix_id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('directory','output')),
        path TEXT NOT NULL, identity TEXT NOT NULL, stamp TEXT, tree TEXT, journal TEXT,
        PRIMARY KEY(task_id,role,path))`)
      const insert = sql.prepare(
        "INSERT INTO synology_task_paths(task_id,role,path,identity) VALUES (?,'directory',?,?)"
      )
      for (const row of legacy) insert.run(...row)
    })()
  }

  private async directoryId(directory: string) {
    if (
      !path.isAbsolute(directory) ||
      (await this.policy.authorizeDirectory(directory)).canonicalPath !==
        directory
    )
      throw Error('Untrusted task directory')
    const info = await lstat(directory, { bigint: true })
    if (!info.isDirectory() || (await realpath(directory)) !== directory)
      throw Error('Task directory changed')
    return fileStamp(info)
  }

  private row(id: string, role: 'directory' | 'output', candidate: string) {
    return this.db.database
      .prepare(
        'SELECT identity,stamp,tree,journal FROM synology_task_paths WHERE task_id=? AND role=? AND path=?'
      )
      .get(id, role, candidate) as PathClaim | undefined
  }

  async create(task: DownloadTask, persist: () => void | Promise<void>) {
    const id = await this.directoryId(task.saveDir)
    await persist()
    this.db.database
      .prepare(
        "INSERT INTO synology_task_paths(task_id,role,path,identity) VALUES (?,'directory',?,?) ON CONFLICT DO NOTHING"
      )
      .run(task.id, task.saveDir, id)
    await this.checkDirectory(task)
  }

  async checkDirectory(task: DownloadTask) {
    const claim = this.row(task.id, 'directory', task.saveDir)
    if (!claim || (await this.directoryId(task.saveDir)) !== claim.identity)
      throw Error('Task download directory changed')
  }

  private published(id: string, candidate: string) {
    return this.db.database
      .prepare(`SELECT plan_id AS journal,target_identity_json AS artifact
      FROM plugin_finalize_journals WHERE task_id=? AND phase IN ('db_committed','cleaned')
      AND json_extract(plan_json,'$.plan.targetPath')=?`)
      .get(id, candidate) as Published | undefined
  }

  private async capture(task: DownloadTask, members: readonly string[]) {
    const target = task.finalPath || task.diskPath
    const info = await lstat(target, { bigint: true })
    if (
      (!info.isFile() && !info.isDirectory()) ||
      (await realpath(target)) !== target
    )
      throw Error('Invalid task output')
    // Certify only tracked torrent members and their ancestors. A file added
    // by another share user must never become part of a recursive removal.
    const tree = info.isDirectory()
      ? await snapshotMembers(target, members)
      : null
    return { target, identity: fileId(info), stamp: fileStamp(info), tree }
  }

  private writeOutput(
    task: DownloadTask,
    proof: Awaited<ReturnType<SynologyTaskFiles['capture']>>
  ) {
    const journal = this.published(task.id, proof.target)?.journal ?? null
    this.db.database
      .prepare(`INSERT INTO synology_task_paths VALUES (?,'output',?,?,?,?,?)
      ON CONFLICT(task_id,role,path) DO UPDATE SET identity=excluded.identity,stamp=excluded.stamp,tree=excluded.tree,journal=excluded.journal`)
      .run(
        task.id,
        proof.target,
        proof.identity,
        proof.stamp,
        proof.tree ? JSON.stringify(proof.tree) : null,
        journal
      )
  }

  async recordOutput(task: DownloadTask, metadata: Uint8Array) {
    await this.checkDirectory(task)
    const layout = await parseBtFileLayout(metadata)
    if (task.infoHash && layout.infoHash !== task.infoHash.toLowerCase())
      throw Error('Torrent identity changed')
    const target = task.finalPath || task.diskPath
    const selected = task.bt?.selectedFiles
    const members = layout.files
      .filter((f) => !selected?.length || selected.includes(f.fileIndex))
      .map((f) =>
        f.pathInsideRoot ? path.join(target, f.pathInsideRoot) : target
      )
    const before = await this.capture(task, members)
    const old = this.row(task.id, 'output', target)
    if (old && old.identity !== before.identity)
      throw Error('Task output changed')
    const result = await verifyBtFiles({
      metadata,
      payloadPath: target,
      selectedFiles: selected,
    })
    // Partial torrents may no longer have boundary pieces from unselected files.
    // Keep the download; only verifiable payloads can acquire a destructive claim.
    if (!result.complete) return
    const after = await this.capture(task, members)
    await this.checkDirectory(task)
    if (!this.sameOutput(before, after))
      throw Error('Task output changed during verification')
    this.writeOutput(task, after)
  }

  private sameOutput(
    first: Awaited<ReturnType<SynologyTaskFiles['capture']>>,
    second: Awaited<ReturnType<SynologyTaskFiles['capture']>>
  ) {
    return (
      first.identity === second.identity &&
      first.stamp === second.stamp &&
      JSON.stringify(first.tree) === JSON.stringify(second.tree)
    )
  }

  async outputIdentity(
    task: DownloadTask,
    candidate: string,
    selected = candidate
  ) {
    await this.checkDirectory(task)
    const journal = this.published(task.id, candidate),
      record = this.row(task.id, 'output', candidate)
    // A verified locate supersedes an older journal for this task and path.
    if (record && record.journal === (journal?.journal ?? null)) {
      const info = await existing(selected)
      if (info && fileStamp(info) !== record.stamp)
        throw Error('Task output changed')
      return record.identity
    }
    if (journal?.artifact) {
      const original = JSON.parse(journal.artifact) as ArtifactIdentity
      const info = await existing(selected)
      if (info) {
        if (fileId(info) !== original.platformFileId)
          throw Error('Task output changed')
        if (
          original.kind === 'file' &&
          (!info.isFile() ||
            !artifactIdentityEquals(
              original,
              await readArtifactIdentity(selected, { cache: this.digests })
            ))
        )
          throw Error('Task output changed')
      }
      return original.platformFileId
    }
    const root = task.finalPath || task.diskPath
    const relative = root && inside(root, candidate)
    if (relative) {
      const parent = this.row(task.id, 'output', root)
      if (parent?.tree) {
        const allowed: Tree = JSON.parse(parent.tree)
        if (Object.hasOwn(allowed, relative)) {
          const info = await existing(selected)
          if (!info || fileStamp(info) !== allowed[relative])
            throw Error('Task output changed')
          return fileId(info)
        }
      }
    }
    if (
      candidate === (task.finalPath || task.diskPath) &&
      (task.status === TaskStatus.Completed ||
        task.status === TaskStatus.Seeding)
    )
      throw Error('No verified identity for this task output')
    return undefined
  }

  async checkOutput(task: DownloadTask, candidate: string) {
    const expected = await this.outputIdentity(task, candidate)
    if (!expected) return
    const info = await existing(candidate)
    if (info && fileId(info) !== expected) throw Error('Task output changed')
  }

  async checkRemoval(task: DownloadTask, candidate: string) {
    await this.removalIdentity(task, candidate, candidate)
    if (
      candidate === task.diskPath &&
      (getBtDirectStorageLayout(task)?.multiFile === false ||
        ((task.type === TaskType.Http || task.type === TaskType.Ftp) &&
          isTempPath(candidate)))
    ) {
      const sidecar = `${candidate}.aria2`
      await this.removalIdentity(task, sidecar, sidecar)
    }
  }

  async removalIdentity(
    task: DownloadTask,
    candidate: string,
    selected: string
  ) {
    await this.checkDirectory(task)
    const info = await existing(selected)
    if (!info) return undefined
    const expected = await this.outputIdentity(task, candidate, selected)
    if (!expected || fileId(info) !== expected)
      throw Error('Task output changed')
    if (info.isDirectory()) {
      const recorded = this.row(task.id, 'output', candidate)
      if (!expected || !recorded?.tree || recorded.identity !== expected)
        throw Error('No verified task directory manifest')
      await verifyMembers(selected, JSON.parse(recorded.tree) as Tree)
    }
    return expected
  }

  /** Move publishes a new durable journal. Locate/recheck must bind the inode
   * that was verified, not whichever file is present afterwards. Other paths
   * keep their original claims if persistence fails or an operation is retried. */
  async prepareStorageBinding(
    task: DownloadTask,
    mode: 'locate' | 'recheck' | 'move',
    members: readonly string[]
  ) {
    const directory = await this.directoryId(task.saveDir)
    const before = mode === 'move' ? null : await this.capture(task, members)
    const bindVerified = async () => {
      if ((await this.directoryId(task.saveDir)) !== directory)
        throw Error('BT storage directory changed')
      const after = before && (await this.capture(task, members))
      if (before && after && !this.sameOutput(before, after))
        throw Error('BT output changed during verification')
      this.db.database.transaction(() => {
        this.db.database
          .prepare(`INSERT INTO synology_task_paths(task_id,role,path,identity) VALUES (?,'directory',?,?)
          ON CONFLICT(task_id,role,path) DO UPDATE SET identity=excluded.identity`)
          .run(task.id, task.saveDir, directory)
        if (after) this.writeOutput(task, after)
      })()
    }
    const bindMoved = async () => {
      const original = this.published(task.id, task.finalPath)?.artifact
      if (!original) throw Error('Missing committed BT storage journal')
      const proof = await this.capture(task, members)
      if (proof.tree) await verifyMembers(proof.target, proof.tree)
      const current = await readArtifactIdentity(proof.target, {
        cache: this.digests,
      })
      if (!artifactIdentityEquals(JSON.parse(original), current))
        throw Error('Moved task output changed')
      await this.checkDirectory(task)
      this.writeOutput(task, proof)
    }
    return { bindVerified, bindMoved }
  }
}
