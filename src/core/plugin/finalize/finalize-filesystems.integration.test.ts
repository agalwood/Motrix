// @vitest-environment node
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DurableFinalizeRuntime } from '@core/session/durable-finalize-runtime'
import { migrate } from '@core/session/migrations'
import { makeDownloadTask } from '@test-utils/task'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeFinalizeFilesystemAdapter } from './filesystem-adapter'
import { NativeFinalizeArtifactOperations } from './native-artifact-operations'

const root = process.env.MOTRIX_FINALIZE_MATRIX_ROOT
const bindRoot = process.env.MOTRIX_FINALIZE_MATRIX_BIND_ROOT
const fsType = process.env.MOTRIX_FINALIZE_MATRIX_TYPE
const binary = path.resolve(
  process.env.MOTRIX_FINALIZE_FS_TEST_BIN ??
    'packages/finalize-fs/target/debug/motrix-finalize-fs'
)
if (root && (process.platform !== 'linux' || !existsSync(binary) || !fsType))
  throw new Error(
    'filesystem matrix requires Linux, a built sidecar and the expected filesystem type'
  )
const magic: Record<string, number> = {
  ext4: 0xef53,
  btrfs: 0x9123683e,
  xfs: 0x58465342,
  f2fs: 0xf2f52010,
  vfat: 0x4d44,
  exfat: 0x2011bab0,
  ntfs3: 0x7366746e,
  'ntfs-3g': 0x65735546,
  tmpfs: 0x01021994,
  overlay: 0x794c7630,
}

describe.runIf(Boolean(root))(
  'mounted Linux filesystem publication',
  { timeout: 30_000 },
  () => {
    const cleanups: (() => Promise<void>)[] = []
    afterEach(async () => {
      vi.restoreAllMocks()
      for (const cleanup of cleanups.splice(0)) await cleanup()
    })

    async function setup(
      mode: 'same' | 'copy' | 'bind' = 'same',
      name = 'download.bin',
      directory = false
    ) {
      expect((await statfs(root!)).type >>> 0).toBe(magic[fsType!])
      const local = await realpath(
        await mkdtemp(path.join(os.tmpdir(), 'motrix-matrix-db-'))
      )
      const artifacts = await realpath(
        await mkdtemp(path.join(root!, 'motrix-matrix-'))
      )
      const source = path.join(
        mode === 'copy' ? local : artifacts,
        `${name}.motrix`
      )
      const target = path.join(
        mode === 'bind'
          ? path.join(bindRoot!, path.basename(artifacts))
          : artifacts,
        name
      )
      if (directory) {
        await mkdir(source)
        await writeFile(path.join(source, 'leaf'), 'payload')
      } else await writeFile(source, name === 'empty' ? '' : 'payload')
      let db: Database.Database
      let adapter: NativeFinalizeFilesystemAdapter
      let fs: NativeFinalizeArtifactOperations
      let runtime: DurableFinalizeRuntime
      const start = () => {
        db = new Database(path.join(local, 'journal.sqlite'))
        migrate(db)
        adapter = new NativeFinalizeFilesystemAdapter(binary)
        fs = new NativeFinalizeArtifactOperations(adapter)
        runtime = new DurableFinalizeRuntime({
          db,
          fs,
          session: {
            persistFinalizedArtifact: async (
              _task,
              _occurrence,
              _effects,
              commit
            ) =>
              commit((journal) => {
                const row = db
                  .prepare(
                    'SELECT plan_json FROM plugin_finalize_journals WHERE plan_id=?'
                  )
                  .get(journal.journalId) as { plan_json: string }
                db.prepare(
                  "UPDATE plugin_finalize_journals SET phase='db_committed', plan_json=? WHERE plan_id=?"
                ).run(
                  JSON.stringify({
                    ...JSON.parse(row.plan_json),
                    phase: 'db_committed',
                  }),
                  journal.journalId
                )
              }),
          },
        })
      }
      start()
      cleanups.push(async () => {
        await adapter.dispose()
        db.close()
        await rm(artifacts, { recursive: true, force: true })
        await rm(local, { recursive: true, force: true })
      })
      const input = {
        task: makeDownloadTask({
          id: 'task-matrix',
          saveDir: path.dirname(target),
          diskPath: source,
          finalPath: target,
        }),
        occurrence: null,
        sourcePath: source,
        targetPath: target,
        metadataOps: [],
        contributors: [],
        postDeliveries: [],
      }
      return {
        source,
        target,
        input,
        get runtime() {
          return runtime
        },
        get fs() {
          return fs
        },
        get adapter() {
          return adapter
        },
        rows: () =>
          db
            .prepare('SELECT phase, plan_json FROM plugin_finalize_journals')
            .all() as { phase: string; plan_json: string }[],
        async restart() {
          await adapter.dispose()
          db.close()
          start()
        },
      }
    }

    it.each(['empty', '中文-é-😀.bin', 'a'.repeat(240)])(
      'publishes %s without copying',
      async (name) => {
        const state = await setup('same', name)
        const copy = vi.spyOn(state.fs, 'materializePrivate')
        await state.runtime.commit(state.input)
        expect(await readFile(state.target, 'utf8')).toBe(
          name === 'empty' ? '' : 'payload'
        )
        expect(existsSync(state.source)).toBe(false)
        expect(copy).not.toHaveBeenCalled()
        expect(state.rows().at(-1)?.phase).toBe('cleaned')
      }
    )

    it('preserves an existing target and its source', async () => {
      const state = await setup()
      await writeFile(state.target, 'unrelated')
      await expect(state.runtime.commit(state.input)).rejects.toThrow()
      expect(await readFile(state.target, 'utf8')).toBe('unrelated')
      expect(await readFile(state.source, 'utf8')).toBe('payload')
    })

    it('respects the mounted filesystem case sensitivity on target conflicts', async () => {
      const state = await setup()
      const otherCase = path.join(path.dirname(state.target), 'DOWNLOAD.BIN')
      await writeFile(otherCase, 'unrelated')
      if (existsSync(state.target)) {
        await expect(state.runtime.commit(state.input)).rejects.toThrow()
        expect(await readFile(state.source, 'utf8')).toBe('payload')
      } else {
        await state.runtime.commit(state.input)
        expect(await readFile(state.target, 'utf8')).toBe('payload')
      }
      expect(await readFile(otherCase, 'utf8')).toBe('unrelated')
    })

    it('keeps unavailable paths retryable and finishes after they return', async () => {
      const state = await setup()
      const directory = path.dirname(state.source)
      const hidden = `${directory}-offline`
      vi.spyOn(state.fs, 'moveNoReplace').mockImplementationOnce(async () => {
        await rename(directory, hidden)
        throw new Error('storage disconnected')
      })
      try {
        await expect(state.runtime.commit(state.input)).rejects.toThrow()
        expect(state.rows().at(-1)?.phase).toBe('prepared')
      } finally {
        if (existsSync(hidden)) await rename(hidden, directory)
      }
      await state.restart()
      await state.runtime.commit(state.input)
      expect(await readFile(state.target, 'utf8')).toBe('payload')
      expect(existsSync(state.source)).toBe(false)
      expect(state.rows().every((row) => row.phase === 'cleaned')).toBe(true)
    })

    it('copies across real devices and removes the source only after commit', async () => {
      const state = await setup('copy')
      expect((await stat(state.source)).dev).not.toBe(
        (await stat(path.dirname(state.target))).dev
      )
      await state.runtime.commit(state.input)
      expect(await readFile(state.target, 'utf8')).toBe('payload')
      expect(existsSync(state.source)).toBe(false)
      expect(state.rows().at(-1)?.phase).toBe('cleaned')
    })

    it.runIf(Boolean(bindRoot))(
      'copies across bind mounts despite equal device numbers',
      async () => {
        const state = await setup('bind')
        expect((await stat(state.source)).dev).toBe(
          (await stat(path.dirname(state.target))).dev
        )
        const move = vi.spyOn(state.adapter, 'renameOpenedNoReplace')
        const copy = vi.spyOn(state.fs, 'materializePrivate')
        await state.runtime.commit(state.input)
        expect(
          await move.mock.results[0].value.catch((error: unknown) => error)
        ).toMatchObject({ code: 'cross_device' })
        expect(copy).toHaveBeenCalledOnce()
        expect(await readFile(state.target, 'utf8')).toBe('payload')
        expect(existsSync(state.source)).toBe(false)
        expect(state.rows().at(-1)?.phase).toBe('cleaned')
      }
    )

    it('recovers a lost publication response after reopening SQLite and the sidecar', async () => {
      const state = await setup()
      if (fsType === 'ntfs-3g') {
        const link = state.adapter.linkOpenedNoReplace.bind(state.adapter)
        vi.spyOn(state.adapter, 'linkOpenedNoReplace').mockImplementation(
          async (...args) => {
            await link(...args)
            throw new Error('lost link response')
          }
        )
        await expect(state.runtime.commit(state.input)).rejects.toThrow()
        await state.restart()
        // An unacknowledged hard link cannot be distinguished from a link
        // created by another client. Preserve both names for reconciliation.
        await expect(state.runtime.commit(state.input)).rejects.toThrow()
        expect(await readFile(state.source, 'utf8')).toBe('payload')
        expect(await readFile(state.target, 'utf8')).toBe('payload')
        expect(state.rows().some((row) => row.phase === 'quarantined')).toBe(
          true
        )
        return
      }
      const original = state.fs.moveNoReplace.bind(state.fs)
      const move = vi
        .spyOn(state.fs, 'moveNoReplace')
        .mockImplementation(async (...args) => {
          await original(...args)
          throw new Error('lost response')
        })
      await expect(state.runtime.commit(state.input)).rejects.toThrow()
      move.mockRestore()
      await state.restart()
      await state.runtime.commit(state.input)
      expect(await readFile(state.target, 'utf8')).toBe('payload')
      expect(existsSync(state.source)).toBe(false)
      expect(state.rows().at(-1)?.phase).toBe('cleaned')
    })

    it('publishes directory artifacts where exclusive directory rename is supported', async () => {
      const state = await setup('same', 'tree', true)
      if (fsType === 'ntfs-3g') {
        await expect(state.runtime.commit(state.input)).rejects.toThrow()
        expect(await readFile(path.join(state.source, 'leaf'), 'utf8')).toBe(
          'payload'
        )
        expect(existsSync(state.target)).toBe(false)
        return
      }
      await state.runtime.commit(state.input)
      expect(await readFile(path.join(state.target, 'leaf'), 'utf8')).toBe(
        'payload'
      )
      expect(existsSync(state.source)).toBe(false)
    })
  }
)
