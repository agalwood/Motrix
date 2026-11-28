// @vitest-environment node
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseEngineTorrent as parseTorrent } from '@shared/lib/engine-torrent'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineSessionRecoveryStore } from '../engine-session-recovery'
import { recoverAria2SessionIdentity } from './aria2-session-identity-recovery'

const PARENT = '1111111111111111'
const CHILD = '2222222222222222'
const OTHER = '3333333333333333'
const folders: string[] = []

async function setup(state = 'paused', schemaVersion: 2 | 3 | 4 | 5 | 6 = 2) {
  const root = await mkdtemp(path.join(tmpdir(), 'motrix-identity-'))
  folders.push(root)
  const file = path.join(root, 'aria2.db')
  const bytes = await readFile(
    path.resolve('src/core/torrent/__fixtures__/test.torrent')
  )
  const parsed = await parseTorrent(new Uint8Array(bytes))
  const metadataPath = path.join(root, `${parsed.infoHash}.torrent`)
  await writeFile(metadataPath, bytes)
  const source = `magnet:?xt=urn:btih:${parsed.infoHash}`
  const entry = (gid: string, paused = false) =>
    `${source}\n gid=${gid}\n dir=${root}\n${paused ? ' pause=true\n' : ''} select-file=1\n index-out=1=renamed.bin\n header=Cookie: private\n`
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')
  db.pragma(`user_version = ${schemaVersion}`)
  // Schema v3 (aria2_motrix 1.37.0-motrix.15) addresses checkpoints by output
  // path and no longer cascades them from task.
  const progressTable =
    schemaVersion >= 3
      ? 'CREATE TABLE task_progress(gid TEXT NOT NULL, bitfield BLOB, out_path TEXT UNIQUE);'
      : 'CREATE TABLE task_progress(gid TEXT PRIMARY KEY REFERENCES task(gid) ON DELETE CASCADE, bitfield BLOB);'
  db.exec(`
    CREATE TABLE task(gid TEXT PRIMARY KEY, state TEXT, serialized TEXT,
      digest BLOB, bt_local_path TEXT, updated_at INTEGER, queue_position INTEGER);
    ${progressTable}
    CREATE TABLE task_cookie_context(gid TEXT PRIMARY KEY REFERENCES task(gid) ON DELETE CASCADE, secret TEXT);
    CREATE TABLE download_history(id INTEGER PRIMARY KEY, gid TEXT, status TEXT, followed_by TEXT);
  `)
  if (schemaVersion >= 4)
    db.exec(
      'CREATE TABLE legacy_checkpoint_import(token TEXT PRIMARY KEY, gid TEXT, consumed INTEGER)'
    )
  if (schemaVersion >= 5)
    db.exec(
      'CREATE TABLE legacy_torrent_metadata(token TEXT PRIMARY KEY, gid TEXT, metadata_digest TEXT)'
    )
  const insert = db.prepare('INSERT INTO task VALUES (?, ?, ?, ?, NULL, 0, ?)')
  insert.run(PARENT, 'waiting', entry(PARENT), Buffer.from('parent-digest'), 0)
  insert.run(
    CHILD,
    state,
    entry(PARENT, state === 'paused'),
    Buffer.from('child-digest'),
    1
  )
  insert.run(
    OTHER,
    'waiting',
    'https://example.test/file\n gid=3333333333333333\n',
    Buffer.from('other-digest'),
    2
  )
  db.prepare('INSERT INTO task_progress (gid, bitfield) VALUES (?, ?)').run(
    CHILD,
    Buffer.from([0xaa, 0xc0])
  )
  db.prepare('INSERT INTO task_cookie_context VALUES (?, ?)').run(
    CHILD,
    'private-cookie'
  )
  db.prepare('INSERT INTO download_history VALUES (1, ?, ?, ?)').run(
    PARENT,
    'complete',
    JSON.stringify([CHILD])
  )
  const rows = () =>
    db.prepare('SELECT * FROM task ORDER BY queue_position').all()
  return { root, file, bytes, metadataPath, db, rows, entry }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true }))
  )
})

describe('aria2 persisted task identity recovery', () => {
  const recoveryStore = (): EngineSessionRecoveryStore => ({
    getContext: () => ({ metadataPaths: [], retired: false }),
    quarantine: vi.fn().mockResolvedValue(undefined),
  })

  it.each([2, 3, 4, 5, 6] as const)(
    'quarantines missing metadata with a complete backup on schema v%s',
    async (schemaVersion) => {
      const h = await setup('waiting', schemaVersion)
      try {
        await unlink(h.metadataPath)
        const before = h.rows()
        h.db
          .prepare('INSERT INTO download_history VALUES (?, ?, ?, ?)')
          .run(2, CHILD, 'error', null)
        h.db
          .prepare('INSERT INTO download_history VALUES (?, ?, ?, ?)')
          .run(3, OTHER, 'complete', '[]')
        const history = h.db.prepare('SELECT * FROM download_history').all()
        const store = recoveryStore()
        store.quarantine = vi.fn(async (tasks) => {
          expect(tasks).toMatchObject([
            {
              engineTaskId: CHILD,
              metadataTaskId: PARENT,
              reason: 'metadata-unavailable',
            },
          ])
          expect(h.rows()).toEqual(before)
          const backups = (await readdir(h.root)).filter((name) =>
            name.includes('identity-recovery-')
          )
          const backup = new Database(
            path.join(h.root, backups[0], 'aria2.db'),
            { readonly: true }
          )
          try {
            expect(
              backup.prepare('SELECT * FROM task ORDER BY queue_position').all()
            ).toEqual(before)
            expect(
              backup.prepare('SELECT * FROM task_progress').all()
            ).toHaveLength(1)
            expect(
              backup.prepare('SELECT * FROM task_cookie_context').all()
            ).toHaveLength(1)
            expect(
              backup.prepare('SELECT * FROM download_history').all()
            ).toEqual(history)
          } finally {
            backup.close()
          }
        })
        const result = await recoverAria2SessionIdentity(
          h.file,
          () => true,
          store
        )
        expect(result?.quarantinedGids).toEqual([CHILD])
        expect(result?.repairedGids).toEqual([])
        expect(h.rows()).toEqual([before[2]])
        expect(h.db.prepare('SELECT * FROM task_progress').all()).toEqual([])
        expect(h.db.prepare('SELECT * FROM task_cookie_context').all()).toEqual(
          []
        )
        expect(h.db.prepare('SELECT * FROM download_history').all()).toEqual(
          history.filter((row) => (row as { gid: string }).gid !== PARENT)
        )
        expect(
          await recoverAria2SessionIdentity(h.file, () => true, store)
        ).toBeNull()
        expect(store.quarantine).toHaveBeenCalledOnce()
      } finally {
        h.db.close()
      }
    }
  )

  it('uses only hash-verified cached metadata when the download copy is missing', async () => {
    const h = await setup()
    try {
      await unlink(h.metadataPath)
      const cached = path.join(h.root, 'app-cache.torrent')
      const invalid = path.join(h.root, 'invalid.torrent')
      await writeFile(cached, h.bytes)
      await writeFile(
        invalid,
        await readFile('scripts/poc/fixtures/multi.torrent')
      )
      const store = recoveryStore()
      store.getContext = () => ({
        metadataPaths: [invalid, cached],
        retired: false,
      })
      const result = await recoverAria2SessionIdentity(
        h.file,
        () => true,
        store
      )
      expect(result?.repairedGids).toEqual([CHILD])
      expect(result?.quarantinedGids).toEqual([])
      expect(store.quarantine).not.toHaveBeenCalled()
      const row = h.db
        .prepare('SELECT bt_local_path FROM task WHERE gid = ?')
        .get(CHILD) as { bt_local_path: string }
      expect(await readFile(row.bt_local_path)).toEqual(h.bytes)
    } finally {
      h.db.close()
    }
  })

  it('repairs a healthy BT identity in the same transaction that isolates a broken task', async () => {
    const h = await setup()
    try {
      const good = '4444444444444444'
      const directory = path.join(h.root, 'healthy')
      await mkdir(directory)
      await writeFile(
        path.join(directory, path.basename(h.metadataPath)),
        h.bytes
      )
      const serialized = h
        .entry('5555555555555555', true)
        .replace(`dir=${h.root}`, `dir=${directory}`)
      h.db
        .prepare(
          'INSERT INTO task SELECT ?, state, ?, digest, bt_local_path, updated_at, queue_position + 10 FROM task WHERE gid = ?'
        )
        .run(good, serialized, CHILD)
      h.db
        .prepare('INSERT INTO task_progress (gid, bitfield) VALUES (?, ?)')
        .run(good, Buffer.from([0xff]))
      await unlink(h.metadataPath)
      const result = await recoverAria2SessionIdentity(
        h.file,
        () => true,
        recoveryStore()
      )
      expect(result?.repairedGids).toEqual([good])
      expect(result?.quarantinedGids).toEqual([CHILD])
      expect(h.db.prepare('SELECT * FROM task_progress').all()).toEqual([
        { gid: good, bitfield: Buffer.from([0xff]) },
      ])
      const repaired = h.db
        .prepare('SELECT serialized, state FROM task WHERE gid = ?')
        .get(good) as { serialized: string; state: string }
      expect(repaired.state).toBe('paused')
      expect(repaired.serialized).toContain(`gid=${good}`)
      expect(
        await recoverAria2SessionIdentity(h.file, () => true, recoveryStore())
      ).toBeNull()
    } finally {
      h.db.close()
    }
  })

  it('does not recreate a deleted download directory even with cached metadata', async () => {
    const h = await setup()
    try {
      const missingDir = path.join(h.root, 'deleted-download')
      h.db
        .prepare('UPDATE task SET serialized = replace(serialized, ?, ?)')
        .run(`dir=${h.root}`, `dir=${missingDir}`)
      const store = recoveryStore()
      store.getContext = () => ({
        metadataPaths: [h.metadataPath],
        retired: false,
      })
      const result = await recoverAria2SessionIdentity(
        h.file,
        () => true,
        store
      )
      expect(result?.quarantinedGids).toEqual([CHILD])
      expect(store.quarantine).toHaveBeenCalledWith([
        expect.objectContaining({ reason: 'files-missing' }),
      ])
      await expect(readFile(missingDir)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      h.db.close()
    }
  })

  it('leaves engine rows intact if durable application quarantine fails', async () => {
    const h = await setup()
    try {
      await unlink(h.metadataPath)
      const before = h.rows()
      const store = recoveryStore()
      store.quarantine = vi
        .fn()
        .mockRejectedValue(new Error('application database full'))
      await expect(
        recoverAria2SessionIdentity(h.file, () => true, store)
      ).rejects.toThrow('application database full')
      expect(h.rows()).toEqual(before)
    } finally {
      h.db.close()
    }
  })

  it('finishes quarantine after a failed engine transaction even if metadata reappears', async () => {
    const h = await setup()
    try {
      await unlink(h.metadataPath)
      let retired = false
      const store = recoveryStore()
      store.getContext = () => ({ metadataPaths: [], retired })
      store.quarantine = vi.fn(async () => {
        retired = true
      })
      h.db.exec(
        "CREATE TRIGGER refuse_delete BEFORE DELETE ON task BEGIN SELECT RAISE(ABORT, 'injected failure'); END"
      )
      await expect(
        recoverAria2SessionIdentity(h.file, () => true, store)
      ).rejects.toThrow('injected failure')
      expect(h.rows()).toHaveLength(3)
      h.db.exec('DROP TRIGGER refuse_delete')
      await writeFile(h.metadataPath, h.bytes)
      const result = await recoverAria2SessionIdentity(
        h.file,
        () => true,
        store
      )
      expect(result?.quarantinedGids).toEqual([CHILD])
      expect(result?.repairedGids).toEqual([])
      expect(h.rows()).toHaveLength(1)
    } finally {
      h.db.close()
    }
  })

  it.each(['invalid', 'mismatched'])(
    'quarantines %s metadata when no verified cache exists',
    async (variant) => {
      const h = await setup()
      try {
        await writeFile(
          h.metadataPath,
          variant === 'invalid'
            ? Buffer.from('broken')
            : await readFile('scripts/poc/fixtures/multi.torrent')
        )
        const result = await recoverAria2SessionIdentity(
          h.file,
          () => true,
          recoveryStore()
        )
        expect(result?.quarantinedGids).toEqual([CHILD])
        expect(h.rows()).toHaveLength(1)
      } finally {
        h.db.close()
      }
    }
  )
  it.each(['waiting', 'paused'])(
    'preserves task identity, options and progress (%s)',
    async (state) => {
      const h = await setup(state)
      try {
        const before = h.rows()
        const result = await recoverAria2SessionIdentity(h.file)
        expect(result?.repairedGids).toEqual([CHILD])
        expect(result?.retiredMetadataGids).toEqual([PARENT])
        const backup = new Database(result!.backupPath, { readonly: true })
        try {
          expect(
            backup.prepare('SELECT * FROM task ORDER BY queue_position').all()
          ).toEqual(before)
          expect(backup.pragma('integrity_check', { simple: true })).toBe('ok')
        } finally {
          backup.close()
        }
        const child = h.db
          .prepare('SELECT * FROM task WHERE gid = ?')
          .get(CHILD) as {
          serialized: string
          bt_local_path: string
          digest: Buffer
          state: string
        }
        expect(child.state).toBe(state)
        expect(child.serialized).toContain(`\n gid=${CHILD}\n`)
        expect(child.serialized).toContain(
          ' select-file=1\n index-out=1=renamed.bin\n header=Cookie: private\n'
        )
        expect(child.serialized.includes(' pause=true\n')).toBe(
          state === 'paused'
        )
        expect(child.digest).toEqual(
          createHash('sha1').update(child.serialized).update(state).digest()
        )
        expect(await readFile(child.bt_local_path)).toEqual(h.bytes)
        expect(child.serialized.startsWith(`${child.bt_local_path}\n`)).toBe(
          true
        )
        expect(h.db.prepare('SELECT * FROM task_progress').all()).toEqual([
          { gid: CHILD, bitfield: Buffer.from([0xaa, 0xc0]) },
        ])
        expect(h.db.prepare('SELECT * FROM task_cookie_context').all()).toEqual(
          [{ gid: CHILD, secret: 'private-cookie' }]
        )
        expect(h.rows().at(-1)).toEqual(before.at(-1))
        expect(await recoverAria2SessionIdentity(h.file)).toBeNull()
        expect(
          (await readdir(h.root)).filter((name) =>
            name.includes('identity-recovery-')
          )
        ).toHaveLength(1)
      } finally {
        h.db.close()
      }
    }
  )

  it('does not create a database on first launch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'motrix-identity-empty-'))
    folders.push(root)
    expect(
      await recoverAria2SessionIdentity(path.join(root, 'aria2.db'))
    ).toBeNull()
    expect(await readdir(root)).toEqual([])
  })

  it('uses durable absolute torrent paths with a relative v1 database path', async () => {
    const h = await setup()
    try {
      h.db.pragma('user_version = 1')
      const result = await recoverAria2SessionIdentity(
        path.relative(process.cwd(), h.file)
      )
      expect(result?.repairedGids).toEqual([CHILD])
      const child = h.db
        .prepare('SELECT serialized FROM task WHERE gid = ?')
        .get(CHILD) as { serialized: string }
      expect(path.isAbsolute(child.serialized.split('\n')[0])).toBe(true)
      expect(h.db.pragma('user_version', { simple: true })).toBe(1)
    } finally {
      h.db.close()
    }
  })

  it.each(['missing', 'invalid', 'mismatched'])(
    'leaves the entire session untouched when metadata is %s',
    async (variant) => {
      const h = await setup()
      try {
        const before = h.rows()
        if (variant === 'missing') await unlink(h.metadataPath)
        if (variant === 'invalid')
          await writeFile(h.metadataPath, 'not bencode')
        if (variant === 'mismatched')
          await writeFile(
            h.metadataPath,
            await readFile('scripts/poc/fixtures/multi.torrent')
          )
        await expect(recoverAria2SessionIdentity(h.file)).rejects.toThrow(
          'matching saved torrent metadata is unavailable'
        )
        expect(h.rows()).toEqual(before)
        expect(
          (await readdir(h.root)).some((name) =>
            name.includes('identity-recovery-')
          )
        ).toBe(false)
      } finally {
        h.db.close()
      }
    }
  )

  it('does not retire an ancestor without a matching completed history link', async () => {
    const h = await setup()
    try {
      h.db
        .prepare('UPDATE download_history SET followed_by = ?')
        .run(JSON.stringify([OTHER]))
      const before = h.rows()
      await expect(recoverAria2SessionIdentity(h.file)).rejects.toThrow(
        'metadata ancestry could not be verified'
      )
      expect(h.rows()).toEqual(before)
    } finally {
      h.db.close()
    }
  })

  it('repairs the payload if the old metadata row was already removed', async () => {
    const h = await setup()
    try {
      h.db.prepare('DELETE FROM task WHERE gid = ?').run(PARENT)
      const result = await recoverAria2SessionIdentity(h.file)
      expect(result?.repairedGids).toEqual([CHILD])
      expect(result?.retiredMetadataGids).toEqual([PARENT])
      expect(h.db.prepare('SELECT * FROM download_history').all()).toEqual([])
    } finally {
      h.db.close()
    }
  })

  it('preserves history without a verified metadata link when the ancestor task is absent', async () => {
    const h = await setup()
    try {
      h.db.prepare('DELETE FROM task WHERE gid = ?').run(PARENT)
      h.db
        .prepare('UPDATE download_history SET followed_by = ?')
        .run(JSON.stringify([OTHER]))
      const before = h.db.prepare('SELECT * FROM download_history').all()
      const result = await recoverAria2SessionIdentity(h.file)
      expect(result?.repairedGids).toEqual([CHILD])
      expect(result?.retiredMetadataGids).toEqual([])
      expect(h.db.prepare('SELECT * FROM download_history').all()).toEqual(
        before
      )
    } finally {
      h.db.close()
    }
  })

  it('removes duplicate verified ancestor histories and their dependent records only', async () => {
    const h = await setup()
    try {
      h.db.exec(`
        CREATE TABLE download_history_files(history_id INTEGER REFERENCES download_history(id) ON DELETE CASCADE, path TEXT);
        INSERT INTO download_history_files VALUES (1, 'metadata.torrent');
      `)
      h.db
        .prepare('INSERT INTO download_history VALUES (0, ?, ?, ?)')
        .run(PARENT, 'error', '[]')
      h.db
        .prepare('INSERT INTO download_history VALUES (2, ?, ?, ?)')
        .run(PARENT, 'complete', JSON.stringify([CHILD]))
      h.db
        .prepare('INSERT INTO download_history_files VALUES (?, ?)')
        .run(2, 'metadata-copy.torrent')
      const result = await recoverAria2SessionIdentity(h.file)
      expect(result?.retiredMetadataGids).toEqual([PARENT])
      expect(h.db.prepare('SELECT * FROM download_history').all()).toEqual([
        { id: 0, gid: PARENT, status: 'error', followed_by: '[]' },
      ])
      expect(
        h.db.prepare('SELECT * FROM download_history_files').all()
      ).toEqual([])
    } finally {
      h.db.close()
    }
  })

  it('rolls back task and progress retirement when verified history cleanup fails', async () => {
    const h = await setup()
    try {
      h.db.exec(
        `CREATE TRIGGER refuse_history_delete BEFORE DELETE ON download_history BEGIN SELECT RAISE(ABORT, 'injected history failure'); END`
      )
      const before = h.rows()
      const history = h.db.prepare('SELECT * FROM download_history').all()
      await expect(recoverAria2SessionIdentity(h.file)).rejects.toThrow(
        'injected history failure'
      )
      expect(h.rows()).toEqual(before)
      expect(h.db.prepare('SELECT * FROM task_progress').all()).toHaveLength(1)
      expect(h.db.prepare('SELECT * FROM download_history').all()).toEqual(
        history
      )
    } finally {
      h.db.close()
    }
  })

  it('rolls back the payload update when ancestor retirement fails', async () => {
    const h = await setup()
    try {
      h.db.exec(
        `CREATE TRIGGER refuse_delete BEFORE DELETE ON task BEGIN SELECT RAISE(ABORT, 'injected failure'); END`
      )
      const before = h.rows()
      await expect(recoverAria2SessionIdentity(h.file)).rejects.toThrow(
        'injected failure'
      )
      expect(h.rows()).toEqual(before)
      expect(h.db.prepare('SELECT * FROM task_progress').all()).toHaveLength(1)
    } finally {
      h.db.close()
    }
  })

  it('aborts when a separate connection changes the database during backup', async () => {
    const h = await setup()
    const original = Database.prototype.backup
    vi.spyOn(Database.prototype, 'backup').mockImplementation(async function (
      this: Database.Database,
      ...args
    ) {
      const result = await original.apply(this, args)
      h.db
        .prepare('UPDATE task SET state = ? WHERE gid = ?')
        .run('waiting', CHILD)
      return result
    })
    try {
      await expect(recoverAria2SessionIdentity(h.file)).rejects.toThrow(
        'session changed during recovery'
      )
      expect(
        h.db.prepare('SELECT serialized FROM task WHERE gid = ?').get(CHILD)
      ).toEqual({ serialized: h.entry(PARENT, true) })
      expect(h.rows()).toHaveLength(3)
    } finally {
      h.db.close()
    }
  })

  it('does not write when engine shutdown or another start cancels recovery', async () => {
    const h = await setup()
    try {
      const before = h.rows()
      await expect(
        recoverAria2SessionIdentity(h.file, () => false)
      ).rejects.toThrow('requires a stopped engine')
      expect(h.rows()).toEqual(before)
    } finally {
      h.db.close()
    }
  })

  it.each([3, 4, 5] as const)(
    'repairs schema v%s and preserves unrelated migration claims',
    async (schemaVersion) => {
      // v3 dropped the task→task_progress CASCADE, so retiring the metadata
      // ancestor must delete its checkpoint itself or it would outlive the task.
      const h = await setup('paused', schemaVersion)
      try {
        h.db
          .prepare('INSERT INTO task_progress (gid, bitfield) VALUES (?, ?)')
          .run(PARENT, Buffer.from([0xff]))
        if (schemaVersion >= 4)
          h.db
            .prepare('INSERT INTO legacy_checkpoint_import VALUES (?, ?, 1)')
            .run('unchanged-token', OTHER)
        if (schemaVersion >= 5)
          h.db
            .prepare('INSERT INTO legacy_torrent_metadata VALUES (?, ?, ?)')
            .run('unchanged-token', OTHER, 'unchanged-digest')
        const result = await recoverAria2SessionIdentity(h.file)
        expect(result?.repairedGids).toEqual([CHILD])
        expect(result?.retiredMetadataGids).toEqual([PARENT])
        if (schemaVersion >= 4)
          expect(
            h.db.prepare('SELECT * FROM legacy_checkpoint_import').all()
          ).toEqual([{ token: 'unchanged-token', gid: OTHER, consumed: 1 }])
        if (schemaVersion >= 5)
          expect(
            h.db.prepare('SELECT * FROM legacy_torrent_metadata').all()
          ).toEqual([
            {
              token: 'unchanged-token',
              gid: OTHER,
              metadata_digest: 'unchanged-digest',
            },
          ])
        expect(
          h.db.prepare('SELECT gid, bitfield FROM task_progress').all()
        ).toEqual([{ gid: CHILD, bitfield: Buffer.from([0xaa, 0xc0]) }])
      } finally {
        h.db.close()
      }
    }
  )

  it.each([PARENT, CHILD])(
    'refuses repair involving a migration-owned GID %s',
    async (gid) => {
      const h = await setup('paused', 5)
      try {
        h.db
          .prepare('INSERT INTO legacy_checkpoint_import VALUES (?, ?, 1)')
          .run('owned-token', gid)
        const before = h.rows()
        const progress = h.db.prepare('SELECT * FROM task_progress').all()
        await expect(recoverAria2SessionIdentity(h.file)).rejects.toThrow(
          'legacy checkpoint identity is immutable'
        )
        expect(h.rows()).toEqual(before)
        expect(h.db.prepare('SELECT * FROM task_progress').all()).toEqual(
          progress
        )
        expect(
          (await readdir(h.root)).filter((name) =>
            name.includes('identity-recovery-')
          )
        ).toHaveLength(0)
      } finally {
        h.db.close()
      }
    }
  )

  it('leaves an unfamiliar future schema unchanged', async () => {
    const h = await setup()
    try {
      h.db.pragma('user_version = 7')
      const before = h.rows()
      expect(await recoverAria2SessionIdentity(h.file)).toBeNull()
      expect(h.rows()).toEqual(before)
    } finally {
      h.db.close()
    }
  })
})
