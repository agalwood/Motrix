import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { NativeFinalizeFilesystemAdapter } from '@core/plugin/finalize/filesystem-adapter'
import { NativeFinalizeArtifactOperations } from '@core/plugin/finalize/native-artifact-operations'
import { DurableFinalizeRuntime } from '@core/session/durable-finalize-runtime'
import { migrate } from '@core/session/migrations'
import {
  bundledAria2Exists,
  canBindLoopbackTcp,
  resolveBundledAria2,
} from '@test-utils/aria2'
import { makeDownloadTask } from '@test-utils/task'
import Database from 'better-sqlite3'
import { expect, it } from 'vitest'

const helper =
  process.env.MOTRIX_FINALIZE_FS_TEST_BIN ??
  path.resolve(
    'packages/finalize-fs/target/debug',
    process.platform === 'win32'
      ? 'motrix-finalize-fs.exe'
      : 'motrix-finalize-fs'
  )

// Packaging supplies both native binaries. A missing configured binary must
// fail that job; source-only checkouts can run the filesystem suite separately.
it.runIf(
  process.env.MOTRIX_ARIA2_TEST_BIN ||
    (bundledAria2Exists() && existsSync(helper) && canBindLoopbackTcp())
)(
  'publishes completed aria2 HTTP downloads through the SQLite journal',
  async () => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'motrix-http-finalize-'))
    )
    const adapter = new NativeFinalizeFilesystemAdapter(path.resolve(helper))
    const db = new Database(':memory:')
    const bytes = Buffer.alloc(512 * 1024, 0x51)
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'Content-Length': bytes.length,
        'Last-Modified': new Date(100000).toUTCString(),
      })
      response.end(bytes)
    })
    try {
      migrate(db)
      const runtime = new DurableFinalizeRuntime({
        db,
        fs: new NativeFinalizeArtifactOperations(adapter),
        session: {
          persistFinalizedArtifact: async (
            _task,
            _occurrence,
            _input,
            install
          ) =>
            install(({ journalId }) => {
              db.prepare(
                "UPDATE plugin_finalize_journals SET phase='db_committed', plan_json=json_set(plan_json,'$.phase','db_committed') WHERE plan_id=? AND phase='target_installed'"
              ).run(journalId)
            }),
        },
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      if (!address || typeof address === 'string')
        throw new Error('expected listener port')
      for (const name of ['installer.exe', 'archive.zip']) {
        const targetPath = path.join(root, name)
        const sourcePath = `${targetPath}.motrix`
        await promisify(execFile)(
          resolveBundledAria2(),
          [
            '--no-conf',
            '--file-allocation=none',
            '--remote-time=true',
            '--dir',
            root,
            '--out',
            `${name}.motrix`,
            `http://127.0.0.1:${address.port}/${name}`,
          ],
          { timeout: 15000 }
        )
        const result = await runtime.commit({
          task: makeDownloadTask({
            id: name,
            saveDir: root,
            diskPath: sourcePath,
            finalPath: targetPath,
          }),
          occurrence: null,
          sourcePath,
          targetPath,
          contributors: [],
          metadataOps: [],
          postDeliveries: [],
        })
        expect(existsSync(sourcePath)).toBe(false)
        expect(await readFile(targetPath)).toEqual(bytes)
        expect(
          db
            .prepare(
              'SELECT phase FROM plugin_finalize_journals WHERE plan_id=?'
            )
            .get(result.journalId)
        ).toEqual({ phase: 'cleaned' })
      }
    } finally {
      if (server.listening)
        await new Promise<void>((resolve) => server.close(() => resolve()))
      await adapter.dispose()
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  45000
)
