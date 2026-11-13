import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { TaskStatus } from '@shared/types/task'
import { listen, start } from '@test-utils/taiji'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrateTaijiSession } from './taiji-session-migration'

const bundled = path.resolve(
  'extra',
  process.platform,
  process.arch,
  process.platform === 'win32' ? 'taiji.exe' : 'taiji'
)
const binary = process.env.MOTRIX_TAIJI_BIN ?? bundled
const execute = promisify(execFile)
const gid = '00000000000000aa'

function seed(
  source: string,
  directory: string,
  uri = 'http://127.0.0.1:9/legacy.bin'
) {
  const db = new Database(source)
  const fixture = readFileSync(
    path.resolve('tests/fixtures/taiji/aria2-v6.sql'),
    'utf8'
  )
    .replaceAll('{{DOWNLOAD_DIR}}', directory.replaceAll("'", "''"))
    .replaceAll('{{SOURCE_URI}}', uri.replaceAll("'", "''"))
    .replaceAll('{{GID}}', gid)
  db.exec(fixture)

  db.close()
}

function row(target: string) {
  const db = new Database(target, { readonly: true })
  try {
    return db
      .prepare(
        'SELECT gid, state, config_json, updated_at FROM http_task WHERE gid = ?'
      )
      .get(gid) as Record<string, unknown>
  } finally {
    db.close()
  }
}

describe.skipIf(!process.env.MOTRIX_TAIJI_BIN && !existsSync(bundled))(
  'taiji legacy session migration',
  () => {
    it('keeps the old database byte-for-byte, preserves task identity, and never replays a completed migration', async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'motrix-taiji-migrate-')
      )
      const source = path.join(directory, 'aria2.db')
      const target = path.join(directory, 'taiji.sqlite3')
      try {
        seed(source, directory)
        const original = await readFile(source)
        await migrateTaijiSession(binary, source, target, directory)
        expect(await readFile(source)).toEqual(original)
        expect(row(target)).toMatchObject({ gid, state: 'paused' })
        const native = new Database(target, { readonly: true })
        try {
          expect(
            native
              .prepare(
                'SELECT name, value, host_only FROM task_cookie WHERE gid=?'
              )
              .get(gid)
          ).toEqual({ name: 'auth', value: 'fixture-cookie', host_only: 1 })
          expect(row(target).config_json).toContain(
            'Authorization: Bearer fixture-only'
          )
        } finally {
          native.close()
        }

        const db = new Database(target)
        db.prepare('UPDATE http_task SET updated_at = 12345 WHERE gid = ?').run(
          gid
        )
        db.close()
        await migrateTaijiSession(binary, source, target, directory)
        expect(row(target).updated_at).toBe(12345)
        const old = new Database(source)
        old.prepare('UPDATE task SET updated_at = 9876 WHERE gid = ?').run(gid)
        old.close()
        await expect(
          migrateTaijiSession(binary, source, target, directory)
        ).rejects.toThrow('changed after')
        expect(row(target).updated_at).toBe(12345)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }, 30000)

    it('does not treat a receipt as a replacement for a missing migrated database', async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'motrix-taiji-missing-db-')
      )
      const source = path.join(directory, 'aria2.db')
      const target = path.join(directory, 'taiji.sqlite3')
      try {
        seed(source, directory)
        await migrateTaijiSession(binary, source, target, directory)
        const before = await readFile(source)
        await rm(target)
        await expect(
          migrateTaijiSession(binary, source, target, directory)
        ).rejects.toThrow('database is missing')
        expect(await readFile(source)).toEqual(before)
        expect(existsSync(target)).toBe(false)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }, 30000)

    it('recovers an interrupted receipt write without overwriting an imported task', async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'motrix-taiji-migrate-retry-')
      )
      const source = path.join(directory, 'aria2.db')
      const target = path.join(directory, 'taiji.sqlite3')
      try {
        seed(source, directory)
        await execute(binary, [
          'import',
          '--from-aria2-db',
          source,
          '--sqlite3-db-path',
          target,
          '--preserve-gids',
          ...(process.platform === 'win32' ? ['--i-know-fork-is-closed'] : []),
        ])
        const db = new Database(target)
        db.prepare('UPDATE http_task SET updated_at = 54321 WHERE gid = ?').run(
          gid
        )
        db.close()
        await migrateTaijiSession(binary, source, target, directory)
        expect(row(target).updated_at).toBe(54321)
        expect(existsSync(`${target}.migration.json`)).toBe(true)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }, 30000)

    it('rejects a GID collision with an unrelated native session instead of overwriting it', async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'motrix-taiji-migrate-collision-')
      )
      const source = path.join(directory, 'first.db')
      const other = path.join(directory, 'second.db')
      const target = path.join(directory, 'taiji.sqlite3')
      try {
        seed(source, directory)
        await migrateTaijiSession(binary, source, target, directory)
        const before = row(target)
        seed(other, directory, 'http://127.0.0.1:9/other.bin')
        await rm(`${target}.migration.json`)
        await expect(
          migrateTaijiSession(binary, other, target, directory)
        ).rejects.toThrow('original database is preserved')
        expect(row(target)).toEqual(before)
        expect(existsSync(`${target}.migration.json`)).toBe(false)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    }, 30000)
    it.each([false, true])(
      'resumes schema 6 partial data with cookies and refuses changed resource identity (%s)',
      async (changed) => {
        const directory = await mkdtemp(
          path.join(tmpdir(), 'motrix-taiji-v6-resume-')
        )
        const source = path.join(directory, 'aria2.db')
        const target = path.join(directory, 'taiji.sqlite3')
        const payload = Buffer.concat([
          Buffer.alloc(1048576, 11),
          Buffer.alloc(1048576, 12),
        ])
        const partial = Buffer.concat([
          payload.subarray(0, 1048576),
          Buffer.alloc(1048576),
        ])
        const ranges: string[] = []
        const server = createServer((request, response) => {
          if (
            request.headers.cookie !== 'auth=fixture-cookie' ||
            request.headers.authorization !== 'Bearer fixture-only'
          ) {
            response.writeHead(403, { 'Content-Length': 0 })
            response.end()
            return
          }
          const range = request.headers.range
          if (range) ranges.push(range)
          const match = /^bytes=(\d+)-(\d*)$/.exec(range ?? '')
          const begin = match ? Number(match[1]) : 0
          const end = match?.[2] ? Number(match[2]) : payload.length - 1
          response.writeHead(match ? 206 : 200, {
            'Content-Length': end - begin + 1,
            'Accept-Ranges': 'bytes',
            ETag: changed ? '"changed"' : '"fixture-etag"',
            ...(match
              ? { 'Content-Range': `bytes ${begin}-${end}/${payload.length}` }
              : {}),
          })
          response.end(
            request.method === 'HEAD'
              ? undefined
              : payload.subarray(begin, end + 1)
          )
        })
        let handle: Awaited<ReturnType<typeof start>> | undefined
        try {
          const port = await listen(server)
          const uri = `http://127.0.0.1:${port}/legacy.bin`
          seed(source, directory, uri)
          const old = new Database(source)
          const digest = createHash('sha256').update(uri).digest('hex')
          old
            .prepare(
              "INSERT INTO task_progress VALUES (?, ?, 1, 0, NULL, 1048576, 2097152, 0, x'80', x'', x'00', 0)"
            )
            .run(gid, path.join(directory, 'legacy.bin'))
          old
            .prepare(
              'INSERT INTO task_http_context VALUES (?, ?, ?, ?, ?, ?, ?)'
            )
            .run(
              gid,
              digest,
              digest,
              path.join(directory, 'legacy.bin'),
              'etag',
              '"fixture-etag"',
              payload.length
            )
          old.close()
          await writeFile(path.join(directory, 'legacy.bin'), partial)
          const originalDb = await readFile(source)
          await migrateTaijiSession(binary, source, target, directory)
          expect(await readFile(source)).toEqual(originalDb)
          expect(
            await readFile(path.join(directory, 'legacy.bin.part'))
          ).toEqual(partial)
          handle = await start(directory, true)
          expect((await handle.adapter.getTaskStatus(gid))?.status).toBe(
            TaskStatus.Paused
          )
          await handle.adapter.resumeTask(gid)
          const terminal = changed ? TaskStatus.Error : TaskStatus.Completed
          for (let i = 0; i < 200; i++) {
            if ((await handle.adapter.getTaskStatus(gid))?.status === terminal)
              break
            await delay(25)
          }
          expect((await handle.adapter.getTaskStatus(gid))?.status).toBe(
            terminal
          )
          if (changed)
            expect(
              await readFile(path.join(directory, 'legacy.bin.part'))
            ).toEqual(partial)
          else {
            expect(await readFile(path.join(directory, 'legacy.bin'))).toEqual(
              payload
            )
            expect(
              ranges.some((range) => range.startsWith('bytes=1048576-'))
            ).toBe(true)
            expect(
              ranges.every(
                (range) =>
                  range === 'bytes=0-0' ||
                  Number(range.split('=')[1].split('-')[0]) >= 1048576
              )
            ).toBe(true)
          }
        } finally {
          await handle?.close()
          server.closeAllConnections()
          await new Promise<void>((resolve) => server.close(() => resolve()))
          await rm(directory, { recursive: true, force: true })
        }
      },
      30000
    )
  }
)
