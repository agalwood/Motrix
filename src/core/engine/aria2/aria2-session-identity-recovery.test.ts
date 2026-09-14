// @vitest-environment node
import { createHash } from 'node:crypto'
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import parseTorrent from 'parse-torrent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recoverAria2SessionIdentity } from './aria2-session-identity-recovery'

const PARENT = '1111111111111111'
const CHILD = '2222222222222222'
const OTHER = '3333333333333333'
const folders: string[] = []

async function setup(state = 'paused') {
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
  db.pragma('user_version = 2')
  db.exec(`
    CREATE TABLE task(gid TEXT PRIMARY KEY, state TEXT, serialized TEXT,
      digest BLOB, bt_local_path TEXT, updated_at INTEGER, queue_position INTEGER);
    CREATE TABLE task_progress(gid TEXT PRIMARY KEY REFERENCES task(gid) ON DELETE CASCADE, bitfield BLOB);
    CREATE TABLE task_cookie_context(gid TEXT PRIMARY KEY REFERENCES task(gid) ON DELETE CASCADE, secret TEXT);
    CREATE TABLE download_history(id INTEGER PRIMARY KEY, gid TEXT, status TEXT, followed_by TEXT);
  `)
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
  db.prepare('INSERT INTO task_progress VALUES (?, ?)').run(
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
      expect(result?.retiredMetadataGids).toEqual([])
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

  it('leaves an unfamiliar future schema unchanged', async () => {
    const h = await setup()
    try {
      h.db.pragma('user_version = 3')
      const before = h.rows()
      expect(await recoverAria2SessionIdentity(h.file)).toBeNull()
      expect(h.rows()).toEqual(before)
    } finally {
      h.db.close()
    }
  })
})
