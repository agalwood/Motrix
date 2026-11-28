import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
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

// Linux 4.4（群晖 DSM 7 主流内核）不支持 statx(STATX_BTIME)，libuv 会将
// birthtimeNs 回退为 ctimeNs；目录内每次创建 .motrix/.aria2 文件都会更新目录 ctime。
// 因此目录身份与快照戳均不得依赖 birthtimeNs，并需平滑兼容旧库中已写入的带 birthtimeNs 记录。
const fileId = (info: { dev: bigint; ino: bigint }) => `${info.dev}:${info.ino}`
const fileStamp = (info: {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  isDirectory(): boolean
}) =>
  info.isDirectory()
    ? fileId(info)
    : `${fileId(info)}:${info.size}:${info.mtimeNs}`

function directoryIdentityMatches(stored: string, current: string): boolean {
  if (stored === current) return true
  // 兼容旧版写入的 `${dev}:${ino}:${birthtimeNs}` 三段目录身份
  if (!stored.startsWith(`${current}:`)) return false
  return /^\d+$/.test(stored.slice(current.length + 1))
}

function fileStampMatches(
  stored: string,
  info: {
    dev: bigint
    ino: bigint
    size: bigint
    mtimeNs: bigint
    isDirectory(): boolean
  }
): boolean {
  if (info.isDirectory()) return directoryIdentityMatches(stored, fileId(info))
  const current = fileStamp(info)
  if (stored === current) return true
  // 兼容旧版写入的 `${dev}:${ino}:${birthtimeNs}:${size}:${mtimeNs}` 五段文件戳
  const prefix = `${fileId(info)}:`
  const suffix = `:${info.size}:${info.mtimeNs}`
  if (!stored.startsWith(prefix) || !stored.endsWith(suffix)) return false
  const middle = stored.slice(prefix.length, stored.length - suffix.length)
  return /^\d+$/.test(middle)
}
type PathClaim = {
  identity: string
  stamp: string
  tree: string | null
  journal: string | null
}
type PartialClaim = {
  identity: string | null
  tree: string | null
}
type Published = { journal: string; artifact: string | null }
type Tree = Record<string, string>

export interface SynologyEngineTaskSnapshot {
  dir: string
  files: readonly string[]
  infoHash?: string
}

export interface SynologyTaskFilesDeps {
  getEngineTask?: (gid: string) => Promise<SynologyEngineTaskSnapshot | null>
  readTorrentMeta?: (metaPath: string) => Promise<Uint8Array>
}

// aria2 控制文件（.aria2）头部最小为 34 字节，限制读取上限防止异常大文件
const MAX_ARIA2_CONTROL_FILE_BYTES = 16n * 1024n * 1024n
const MIN_ARIA2_CONTROL_FILE_BYTES = 34n

function ownedByCurrentProcess(info: { uid: bigint }): boolean {
  if (typeof process.getuid !== 'function') return true
  return info.uid === BigInt(process.getuid())
}

// 严格校验 aria2 v1 二进制控制文件头（对应 aria2 DefaultBtProgressInfoFile.cc）：
// version(2B=1) | extension(4B) | infoHashLen(4B) | infoHash(N) | pieceLen(4B>0) | totalLen(8B) | uploadLen(8B) | bitfieldLen(4B)
async function verifyAria2ControlFile(
  filePath: string,
  expectedInfoHash?: string
): Promise<{ dev: bigint; ino: bigint } | null> {
  const named = await existing(filePath)
  if (!named?.isFile() || !ownedByCurrentProcess(named)) return null
  if ((await realpath(filePath)) !== filePath) return null
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    const info = await handle.stat({ bigint: true })
    if (
      !info.isFile() ||
      info.dev !== named.dev ||
      info.ino !== named.ino ||
      !ownedByCurrentProcess(info) ||
      info.size < MIN_ARIA2_CONTROL_FILE_BYTES ||
      info.size > MAX_ARIA2_CONTROL_FILE_BYTES
    )
      return null
    const headerSize = Math.min(64, Number(info.size))
    const header = Buffer.alloc(headerSize)
    const { bytesRead } = await handle.read(header, 0, headerSize, 0)
    if (bytesRead < Number(MIN_ARIA2_CONTROL_FILE_BYTES)) return null
    const version = header.readUInt16BE(0)
    if (version !== 1) return null
    const infoHashLength = header.readUInt32BE(6)
    if (expectedInfoHash) {
      if (infoHashLength !== 20 || bytesRead < 54) return null
      const savedHash = header.subarray(10, 30).toString('hex')
      if (savedHash !== expectedInfoHash.toLowerCase()) return null
    } else if (infoHashLength !== 0) {
      return null
    }
    const base = 10 + infoHashLength
    if (bytesRead < base + 24) return null
    const pieceLength = header.readUInt32BE(base)
    if (pieceLength === 0) return null
    const bitfieldLength = header.readUInt32BE(base + 20)
    if (BigInt(base + 24) + BigInt(bitfieldLength) > info.size) return null
    return { dev: info.dev, ino: info.ino }
  } finally {
    await handle.close()
  }
}

async function verifyPartialMembers(
  root: string,
  allowed: ReadonlySet<string>,
  relative = ''
) {
  for (const name of await readdir(path.join(root, relative))) {
    const child = path.join(relative, name)
    if (!allowed.has(child)) throw Error('Untracked file in task directory')
    const file = path.join(root, child)
    const info = await lstat(file, { bigint: true })
    if (
      (!info.isFile() && !info.isDirectory()) ||
      !ownedByCurrentProcess(info) ||
      (await realpath(file)) !== file
    )
      throw Error('Unsafe entry in task directory')
    if (info.isDirectory()) await verifyPartialMembers(root, allowed, child)
  }
}

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
      !fileStampMatches(allowed[child], info) ||
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
  private runtimeDeps: SynologyTaskFilesDeps
  constructor(
    private readonly db: Pick<MotrixDatabase, 'database' | 'getAllTasks'>,
    private readonly policy: ServerDownloadPathPolicy,
    deps: SynologyTaskFilesDeps = {}
  ) {
    this.runtimeDeps = deps
  }

  setRuntimeDeps(deps: SynologyTaskFilesDeps) {
    this.runtimeDeps = deps
  }

  async initialize() {
    const sql = this.db.database
    const ensurePartialClaimsTable = () => {
      // 独立表记录新建未完成任务的独占预留与删除前锁定的物理 inode，兼容已有老库结构
      sql.exec(`CREATE TABLE IF NOT EXISTS synology_task_partial_claims (
        task_id TEXT NOT NULL REFERENCES tasks(motrix_id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        identity TEXT,
        tree TEXT,
        PRIMARY KEY(task_id,path))`)
    }
    if (
      sql
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='synology_task_paths'"
        )
        .get()
    ) {
      ensurePartialClaimsTable()
      return
    }
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
      ensurePartialClaimsTable()
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

  private partialClaim(id: string, candidate: string) {
    return this.db.database
      .prepare(
        'SELECT identity,tree FROM synology_task_partial_claims WHERE task_id=? AND path=?'
      )
      .get(id, candidate) as PartialClaim | undefined
  }

  private writePartialClaim(
    taskId: string,
    candidate: string,
    identity: string | null,
    tree: readonly string[] | null = null
  ) {
    this.db.database
      .prepare(
        `INSERT INTO synology_task_partial_claims(task_id,path,identity,tree) VALUES (?,?,?,?)
         ON CONFLICT(task_id,path) DO UPDATE SET identity=excluded.identity,tree=excluded.tree`
      )
      .run(taskId, candidate, identity, tree ? JSON.stringify(tree) : null)
  }

  async create(task: DownloadTask, persist: () => void | Promise<void>) {
    const id = await this.directoryId(task.saveDir)
    // 仅当新建未完成任务的目标路径此刻在磁盘上尚不存在时，记录独占预留，绝不采纳既有文件
    let reservePartialPath: string | null = null
    if (
      task.diskPath &&
      task.status !== TaskStatus.Completed &&
      task.status !== TaskStatus.Seeding &&
      inside(task.saveDir, task.diskPath) &&
      (await existing(task.diskPath)) === null &&
      (await existing(`${task.diskPath}.aria2`)) === null
    ) {
      reservePartialPath = task.diskPath
    }
    await persist()
    this.db.database
      .prepare(
        "INSERT INTO synology_task_paths(task_id,role,path,identity) VALUES (?,'directory',?,?) ON CONFLICT DO NOTHING"
      )
      .run(task.id, task.saveDir, id)
    if (reservePartialPath) {
      this.db.database
        .prepare(
          'INSERT INTO synology_task_partial_claims(task_id,path,identity,tree) VALUES (?,?,NULL,NULL) ON CONFLICT DO NOTHING'
        )
        .run(task.id, reservePartialPath)
    }
    await this.checkDirectory(task)
  }

  async checkDirectory(task: DownloadTask) {
    const claim = this.row(task.id, 'directory', task.saveDir)
    if (
      !claim ||
      !directoryIdentityMatches(
        claim.identity,
        await this.directoryId(task.saveDir)
      )
    )
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
      if (info && !fileStampMatches(record.stamp ?? '', info))
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
          if (!info || !fileStampMatches(allowed[relative], info))
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

  private async hasEngineOwnership(
    task: DownloadTask,
    candidate: string
  ): Promise<boolean> {
    if (!task.engineTaskId || !this.runtimeDeps.getEngineTask) return false
    const live = await this.runtimeDeps
      .getEngineTask(task.engineTaskId)
      .catch(() => null)
    if (!live || path.resolve(live.dir) !== task.saveDir) return false
    if (
      (task.type === TaskType.Bt || task.type === TaskType.Magnet) &&
      task.infoHash &&
      live.infoHash?.toLowerCase() !== task.infoHash.toLowerCase()
    )
      return false
    return live.files.some(
      (file) =>
        path.resolve(file) === candidate ||
        inside(candidate, path.resolve(file)) !== null
    )
  }

  private async certifyPartialRemoval(
    task: DownloadTask,
    candidate: string
  ): Promise<void> {
    if (
      candidate !== task.diskPath ||
      task.status === TaskStatus.Completed ||
      task.status === TaskStatus.Seeding
    )
      return
    if (!inside(task.saveDir, candidate)) return
    const info = await existing(candidate)
    if (!info) return
    const isHttpTemp =
      (task.type === TaskType.Http || task.type === TaskType.Ftp) &&
      isTempPath(candidate)
    const isBt = task.type === TaskType.Bt || task.type === TaskType.Magnet
    if (!isHttpTemp && !isBt) return
    if (isHttpTemp && !info.isFile()) return
    if (isBt && !info.isFile() && !info.isDirectory()) return
    if (!ownedByCurrentProcess(info)) return
    if ((await realpath(candidate)) !== candidate) return

    // 校验强归属证明（三选一）：创建期独占预留 / 引擎实时持有 / 伴生合法 aria2 控制文件
    const reserved = this.partialClaim(task.id, candidate) !== undefined
    const engineOwned = reserved
      ? false
      : await this.hasEngineOwnership(task, candidate)
    const sidecarProof =
      reserved || engineOwned
        ? null
        : isHttpTemp
          ? await verifyAria2ControlFile(`${candidate}.aria2`)
          : isBt && task.infoHash
            ? await verifyAria2ControlFile(`${candidate}.aria2`, task.infoHash)
            : null
    if (!reserved && !engineOwned && !sidecarProof) return

    let allowedTree: string[] | null = null
    if (info.isDirectory()) {
      // 未完成多文件 BT 目录必须用 .torrent 元数据建立成员白名单，禁止删除任何无关文件
      if (!task.torrentMetaPath || !this.runtimeDeps.readTorrentMeta) return
      const metadata = await this.runtimeDeps.readTorrentMeta(
        task.torrentMetaPath
      )
      const layout = await parseBtFileLayout(metadata)
      if (task.infoHash && layout.infoHash !== task.infoHash.toLowerCase())
        throw Error('Torrent identity changed')
      const names = new Set<string>()
      for (const member of layout.files) {
        const full = member.pathInsideRoot
          ? path.join(candidate, member.pathInsideRoot)
          : candidate
        let relative = inside(candidate, full)
        while (relative && relative !== '.') {
          names.add(relative)
          relative = path.dirname(relative)
        }
      }
      // 多文件 BT 的 aria2 控制文件通常位于首个成员同级，仅当校验其 20 字节 infoHash 匹配时放行
      const firstMemberRel = layout.files[0]?.pathInsideRoot
      if (firstMemberRel && task.infoHash) {
        const internalCtrlRel = `${firstMemberRel}.aria2`
        const internalCtrlPath = path.join(candidate, internalCtrlRel)
        if (
          inside(candidate, internalCtrlPath) &&
          (await verifyAria2ControlFile(internalCtrlPath, task.infoHash))
        ) {
          names.add(internalCtrlRel)
        }
      }
      await verifyPartialMembers(candidate, names)
      allowedTree = [...names].sort()
    }
    this.writePartialClaim(task.id, candidate, fileId(info), allowedTree)
  }

  private async certifySidecarRemoval(
    task: DownloadTask,
    candidate: string,
    sidecar: string
  ): Promise<void> {
    if (!inside(task.saveDir, sidecar)) return
    const isBt = task.type === TaskType.Bt || task.type === TaskType.Magnet
    const expectedInfoHash = isBt ? (task.infoHash ?? undefined) : undefined
    if (isBt && !expectedInfoHash) return
    const verified = await verifyAria2ControlFile(sidecar, expectedInfoHash)
    if (!verified) return
    // 确认边车对应的主路径属于当前任务
    if (candidate !== task.diskPath) return
    this.writePartialClaim(task.id, sidecar, fileId(verified), null)
  }

  async checkRemoval(task: DownloadTask, candidate: string) {
    await this.checkDirectory(task)
    // 仅对未完成任务尝试建立删除期物理 inode 锁定，避免已完成任务重复校验哈希
    if (
      task.status !== TaskStatus.Completed &&
      task.status !== TaskStatus.Seeding &&
      (await existing(candidate)) !== null
    ) {
      const existingIdentity = await this.outputIdentity(
        task,
        candidate,
        candidate
      ).catch(() => undefined)
      if (!existingIdentity) {
        await this.certifyPartialRemoval(task, candidate)
      }
    }
    await this.removalIdentity(task, candidate, candidate)
    if (
      candidate === task.diskPath &&
      (getBtDirectStorageLayout(task)?.multiFile === false ||
        ((task.type === TaskType.Http || task.type === TaskType.Ftp) &&
          isTempPath(candidate)))
    ) {
      const sidecar = `${candidate}.aria2`
      if ((await existing(sidecar)) !== null) {
        await this.certifySidecarRemoval(task, candidate, sidecar)
      }
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
    if (expected) {
      if (fileId(info) !== expected) throw Error('Task output changed')
      if (info.isDirectory()) {
        const recorded = this.row(task.id, 'output', candidate)
        if (!recorded?.tree || recorded.identity !== expected)
          throw Error('No verified task directory manifest')
        await verifyMembers(selected, JSON.parse(recorded.tree) as Tree)
      }
      return expected
    }
    // 校验已通过删除预检锁定的未完成临时文件或 .aria2 边车（按物理 dev:ino 匹配，容忍停止前追加写入）
    const partial = this.partialClaim(task.id, candidate)
    if (
      !partial?.identity ||
      fileId(info) !== partial.identity ||
      (!info.isFile() && !info.isDirectory()) ||
      !ownedByCurrentProcess(info) ||
      (await realpath(selected)) !== selected
    )
      throw Error('Task output changed')
    if (info.isDirectory()) {
      if (!partial.tree) throw Error('No verified task directory manifest')
      await verifyPartialMembers(
        selected,
        new Set(JSON.parse(partial.tree) as string[])
      )
    }
    return partial.identity
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
