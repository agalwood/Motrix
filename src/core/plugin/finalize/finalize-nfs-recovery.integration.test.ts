import { existsSync } from 'node:fs'
import {
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
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
import {
  FinalizeFsError,
  NativeFinalizeFilesystemAdapter,
} from './filesystem-adapter'
import { NativeFinalizeArtifactOperations } from './native-artifact-operations'

const binary = path.resolve(
  process.env.MOTRIX_FINALIZE_FS_TEST_BIN ??
    'packages/finalize-fs/target/debug/motrix-finalize-fs'
)
const nfsRoot = process.env.MOTRIX_FINALIZE_NFS_ROOT
if (nfsRoot && (process.platform !== 'linux' || !existsSync(binary))) {
  throw new Error('NFS contract requires Linux and a built native sidecar')
}

describe.runIf(process.platform === 'linux' && existsSync(binary))(
  'NFS finalize publication and recovery',
  { timeout: 30_000 },
  () => {
    const cleanup: (() => Promise<void>)[] = []
    afterEach(async () => {
      vi.restoreAllMocks()
      for (const dispose of cleanup.splice(0)) await dispose()
    }, 30_000)

    async function setup(crossDevice = false) {
      if (nfsRoot) expect((await statfs(nfsRoot)).type).toBe(0x6969)
      const local = await realpath(
        await mkdtemp(path.join(os.tmpdir(), 'motrix-nfs-db-'))
      )
      const root = await realpath(
        await mkdtemp(path.join(nfsRoot ?? local, 'motrix-nfs-'))
      )
      const dbPath = path.join(local, 'journal.sqlite')
      let db = new Database(dbPath)
      migrate(db)
      let adapter: NativeFinalizeFilesystemAdapter
      let fs: NativeFinalizeArtifactOperations
      function createRuntime() {
        adapter = new NativeFinalizeFilesystemAdapter(binary)
        // On local filesystems inject only the missing rename primitive. The
        // link, isolation, removal, identity checks and SQLite are all real.
        if (!nfsRoot)
          vi.spyOn(adapter, 'renameOpenedNoReplace').mockRejectedValue(
            new FinalizeFsError('rename_unsupported', 'NOREPLACE unsupported')
          )
        fs = new NativeFinalizeArtifactOperations(adapter)
        return new DurableFinalizeRuntime({
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
                const raw = db
                  .prepare(
                    'SELECT plan_json FROM plugin_finalize_journals WHERE plan_id=?'
                  )
                  .get(journal.journalId) as { plan_json: string }
                db.prepare(
                  "UPDATE plugin_finalize_journals SET phase='db_committed', plan_json=? WHERE plan_id=?"
                ).run(
                  JSON.stringify({
                    ...JSON.parse(raw.plan_json),
                    phase: 'db_committed',
                  }),
                  journal.journalId
                )
              }),
          },
        })
      }
      let runtime = createRuntime()
      cleanup.push(async () => {
        await adapter.dispose()
        db.close()
        await rm(root, { recursive: true, force: true })
        await rm(local, { recursive: true, force: true })
      })
      const sourcePath = path.join(
        crossDevice ? local : root,
        'download.bin.motrix'
      )
      const targetPath = path.join(root, 'download.bin')
      await writeFile(sourcePath, 'complete download')
      const input = {
        task: makeDownloadTask({
          id: 'task-nfs',
          saveDir: root,
          diskPath: sourcePath,
          finalPath: targetPath,
        }),
        occurrence: null,
        sourcePath,
        targetPath,
        metadataOps: [],
        contributors: [],
        postDeliveries: [],
      }
      return {
        input,
        root,
        get adapter() {
          return adapter
        },
        get fs() {
          return fs
        },
        get runtime() {
          return runtime
        },
        row: () =>
          db
            .prepare('SELECT phase, plan_json FROM plugin_finalize_journals')
            .get() as { phase: string; plan_json: string },
        async restart() {
          await adapter.dispose()
          db.close()
          db = new Database(dbPath)
          runtime = createRuntime()
        },
      }
    }

    it.each([false, true])(
      'publishes and cleans up (cross-device: %s)',
      async (crossDevice) => {
        const s = await setup(crossDevice)
        const link = vi.spyOn(s.adapter, 'linkOpenedNoReplace')
        const copy = vi.spyOn(s.adapter, 'copyOpened')
        await s.runtime.commit(s.input)
        expect(link).toHaveBeenCalledOnce()
        if (crossDevice && nfsRoot) expect(copy).toHaveBeenCalledOnce()
        else expect(copy).not.toHaveBeenCalled()
        expect(s.row().phase).toBe('cleaned')
        expect(await readdir(s.root)).toEqual(['download.bin'])
        expect(existsSync(s.input.sourcePath)).toBe(false)
        expect(await readFile(s.input.targetPath, 'utf8')).toBe(
          'complete download'
        )
      }
    )

    it('preserves an existing target and the complete source', async () => {
      const s = await setup()
      await writeFile(s.input.targetPath, 'unrelated')
      await expect(s.runtime.commit(s.input)).rejects.toThrow()
      expect(await readFile(s.input.targetPath, 'utf8')).toBe('unrelated')
      expect(await readFile(s.input.sourcePath, 'utf8')).toBe(
        'complete download'
      )
    })

    it('preserves uncertain link publication across restart and retry', async () => {
      const s = await setup()
      const link = s.adapter.linkOpenedNoReplace.bind(s.adapter)
      vi.spyOn(s.adapter, 'linkOpenedNoReplace').mockImplementationOnce(
        async (...args) => {
          await link(...args)
          throw new Error('lost link response')
        }
      )
      await expect(s.runtime.commit(s.input)).rejects.toThrow(
        'ownership is unconfirmed'
      )
      expect(s.row().phase).toBe('quarantined')
      await s.restart()
      await s.runtime.recoverAll()
      await expect(s.runtime.commit(s.input)).rejects.toThrow()
      expect(s.row().phase).toBe('quarantined')
      for (const name of [s.input.sourcePath, s.input.targetPath]) {
        expect(await readFile(name, 'utf8')).toBe('complete download')
      }
    })

    it('preserves an unconfirmed link after disconnection blocks live rollback', async () => {
      const s = await setup()
      let offline = false
      const identity = s.fs.identity.bind(s.fs)
      vi.spyOn(s.fs, 'identity').mockImplementation(async (...args) => {
        if (offline) throw new Error('NFS disconnected')
        return identity(...args)
      })
      const link = s.adapter.linkOpenedNoReplace.bind(s.adapter)
      vi.spyOn(s.adapter, 'linkOpenedNoReplace').mockImplementationOnce(
        async (...args) => {
          await link(...args)
          offline = true
          throw new Error('lost link response')
        }
      )
      await expect(s.runtime.commit(s.input)).rejects.toThrow(
        'rollback needs recovery'
      )
      expect(s.row().phase).toBe('prepared')
      expect(existsSync(s.input.sourcePath)).toBe(true)
      expect(existsSync(s.input.targetPath)).toBe(true)
      await s.restart()
      await s.runtime.recoverAll()
      expect(s.row().phase).toBe('quarantined')
      expect(existsSync(s.input.targetPath)).toBe(true)
      expect(await readFile(s.input.sourcePath, 'utf8')).toBe(
        'complete download'
      )
      await expect(s.runtime.commit(s.input)).rejects.toThrow()
      expect(s.row().phase).toBe('quarantined')
    })

    it.each(['before_isolation', 'after_isolation', 'after_unlink'] as const)(
      'reopens the DB and sidecar after cleanup fails %s',
      async (point) => {
        const s = await setup()
        const isolate = s.adapter.isolateOpened.bind(s.adapter)
        const remove = s.adapter.removeOpened.bind(s.adapter)
        if (point === 'after_unlink') {
          vi.spyOn(s.adapter, 'removeOpened').mockImplementationOnce(
            async (...args) => {
              await remove(...args)
              throw new Error('lost removal response')
            }
          )
        } else {
          vi.spyOn(s.adapter, 'isolateOpened').mockImplementationOnce(
            async (...args) => {
              if (point === 'after_isolation') await isolate(...args)
              throw new Error('isolation interruption')
            }
          )
        }
        await s.runtime.commit(s.input)
        expect(s.row().phase).toBe('db_committed')
        expect(
          JSON.parse(s.row().plan_json).removalIntent.isolation
        ).toBeDefined()
        await s.restart()
        await s.runtime.recoverAll()
        expect(s.row().phase).toBe('cleaned')
        expect(existsSync(s.input.sourcePath)).toBe(false)
        expect(await readFile(s.input.targetPath, 'utf8')).toBe(
          'complete download'
        )
        await s.runtime.recoverAll()
        expect(s.row().phase).toBe('cleaned')
      }
    )
  }
)
