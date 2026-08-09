// tests/setup/build-worker.ts
// vitest globalSetup: pre-build quick-js-worker.ts → dist-test/quick-js-worker.cjs
// and ensure the fetched builtin-plugin seeds exist under
// dist/builtin-plugins/<id>/ (plus the dist/builtin-moext/<file> mirrors) so
// host e2e + smoke tests can point at the real artifacts before any test runs.
// Seeds come from scripts/fetch-builtins.mjs — lockfile-pinned, sha256-verified
// release artifacts, cached in node_modules/.cache/motrix-builtins after the
// first fetch (repeat runs are offline).

import { spawn } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'

const ROOT = path.resolve(__dirname, '../..')

async function buildWorker(): Promise<void> {
  await build({
    entryPoints: [path.join(ROOT, 'src/core/plugin/host/quick-js-worker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(ROOT, 'dist-test/quick-js-worker.cjs'),
    external: ['quickjs-emscripten'],
    sourcemap: 'inline',
    logLevel: 'silent',
  })
}

interface LockEntry {
  version: string
  file: string
}

async function seedsUpToDate(): Promise<boolean> {
  const lock = JSON.parse(
    await readFile(path.join(ROOT, 'scripts/builtins.lock.json'), 'utf8')
  ) as { plugins: Record<string, LockEntry> }
  for (const [id, entry] of Object.entries(lock.plugins)) {
    try {
      const manifest = JSON.parse(
        await readFile(
          path.join(ROOT, 'dist/builtin-plugins', id, 'motrix-plugin.json'),
          'utf8'
        )
      ) as { version?: string }
      if (manifest.version !== entry.version) return false
      await stat(path.join(ROOT, 'dist/builtin-moext', entry.file))
    } catch {
      return false
    }
  }
  return true
}

async function ensureBuiltinSeeds(): Promise<void> {
  if (await seedsUpToDate()) return
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(ROOT, 'scripts/fetch-builtins.mjs')],
      { stdio: 'inherit' }
    )
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`fetch-builtins exited with code ${code}`))
    })
  })
}

export default async function setup(): Promise<void> {
  await Promise.all([buildWorker(), ensureBuiltinSeeds()])
}
