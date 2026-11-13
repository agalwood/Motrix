import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'

const execute = promisify(execFile)
const receiptSchema = z.object({
  version: z.literal(1),
  source: z.string(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
})
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === 'ENOENT'

async function fingerprint(
  source: string,
  signal?: AbortSignal
): Promise<string> {
  const hash = createHash('sha256')
  for (const suffix of ['', '-wal']) {
    hash.update(suffix)
    try {
      for await (const chunk of createReadStream(`${source}${suffix}`, {
        signal,
      }))
        hash.update(chunk)
    } catch (error) {
      if (!missing(error)) throw error
    }
  }
  return hash.digest('hex')
}

/** A one-way, read-only import of the old engine database, keeping Motrix GIDs. */
export async function migrateTaijiSession(
  binary: string,
  sourcePath: string,
  target: string,
  saveDir: string,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const source = path.resolve(sourcePath)
  if (source === path.resolve(target))
    throw new Error('Legacy and taiji databases must be distinct')
  try {
    await access(source)
  } catch (error) {
    if (missing(error)) return
    throw error
  }
  const receiptPath = `${target}.migration.json`
  const digest = await fingerprint(source, signal)
  try {
    const receipt = receiptSchema.parse(
      JSON.parse(await readFile(receiptPath, 'utf8'))
    )
    if (receipt.source !== source || receipt.digest !== digest)
      throw new Error('The legacy session changed after its taiji migration')
    try {
      await access(target)
    } catch (error) {
      if (!missing(error)) throw error
      throw new Error(
        'The migrated taiji database is missing; restore its backup before starting'
      )
    }
    return
  } catch (error) {
    if (!missing(error)) throw error
  }

  // Unix uses the native importer's exact-file handle scan. On Windows,
  // prove that no process holds any SQLite companion using exclusive read
  // handles before acknowledging the importer's unavailable procfs/lsof scan.
  if (process.platform === 'win32') {
    const script = `$ErrorActionPreference = 'Stop'; $handles = @(); try {
      foreach ($suffix in @('', '-wal', '-shm')) {
        $file = $env:MOTRIX_MIGRATION_SOURCE + $suffix;
        if ([System.IO.File]::Exists($file)) {
          $handles += [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
        }
      }
    } finally { foreach ($handle in $handles) { $handle.Dispose() } }`
    try {
      await execute(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          timeout: 10000,
          env: { ...process.env, MOTRIX_MIGRATION_SOURCE: source },
          signal,
        }
      )
    } catch {
      throw new Error(
        'Close the previous download engine before migrating its session'
      )
    }
  }
  try {
    await execute(
      binary,
      [
        'import',
        '--from-aria2-db',
        source,
        '--sqlite3-db-path',
        target,
        '--dir',
        saveDir,
        '--preserve-gids',
        ...(process.platform === 'win32' ? ['--i-know-fork-is-closed'] : []),
      ],
      { timeout: 300_000, maxBuffer: 16 * 1024 * 1024, signal }
    )
  } catch {
    throw new Error(
      'taiji could not migrate every legacy task; the original database is preserved'
    )
  }
  if ((await fingerprint(source, signal)) !== digest)
    throw new Error('Legacy session changed while migrating')
  await writeFileAtomic(
    receiptPath,
    JSON.stringify({ version: 1, source, digest }),
    { mode: 0o600 }
  )
}
