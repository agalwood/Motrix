// Runs in a disposable test process. Its parent sends SIGKILL at a real IO cut.
import { writeSync } from 'node:fs'
import {
  FinalizeFsError,
  NativeFinalizeFilesystemAdapter,
} from '@core/plugin/finalize/filesystem-adapter'
import { NativeFinalizeArtifactOperations } from '@core/plugin/finalize/native-artifact-operations'
import {
  type DurableFinalizeArtifactInput,
  DurableFinalizeRuntime,
} from '@core/session/durable-finalize-runtime'
import Database from 'better-sqlite3'

const [dbPath, binary, cut, inputJson] = process.argv.slice(2)
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
const adapter = new NativeFinalizeFilesystemAdapter(binary)
const stop = (): never => {
  writeSync(1, 'FINALIZE_CRASH_CUT\n')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  throw new Error('crash cut unexpectedly resumed')
}
adapter.renameOpenedNoReplace = async () => {
  throw new FinalizeFsError(
    'rename_unsupported',
    'exercise exFAT compatibility',
    {
      operation: 'rename_opened_no_replace',
      osError: 45,
      mutation: 'not_attempted',
    }
  )
}
if (cut === 'reservation-created') {
  const reserve = adapter.reserveExfatTarget.bind(adapter)
  adapter.reserveExfatTarget = async (...args) => {
    await reserve(...args)
    return stop()
  }
}
if (cut === 'target-installed') {
  const rename = adapter.renameOpenedReserved.bind(adapter)
  adapter.renameOpenedReserved = async (...args) => {
    await rename(...args)
    return stop()
  }
}
const runtime = new DurableFinalizeRuntime({
  db,
  fs: new NativeFinalizeArtifactOperations(adapter),
  session: {
    persistFinalizedArtifact: async (_task, _occurrence, _effects, install) =>
      install(() => {
        if (cut === 'before-terminal-commit') stop()
        throw new Error('missed requested crash cut')
      }),
  },
})
void runtime
  .commit(JSON.parse(inputJson) as DurableFinalizeArtifactInput)
  .then(() => {
    throw new Error('unexpected completion')
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
