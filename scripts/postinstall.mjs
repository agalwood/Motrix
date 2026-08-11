#!/usr/bin/env node
// scripts/postinstall.mjs
//
// Two independent, per-step env-guarded stages with NO early process.exit:
//   Stage A — `@electron/rebuild` (rebuilds native modules such as
//             better-sqlite3), skipped only by
//             MOTRIX_SKIP_ELECTRON_REBUILD=1.
//   Stage B — fetch the bundled aria2 binary for the host
//             (fetch-engine.mjs, default host mode), skipped only by
//             MOTRIX_SKIP_ENGINE_FETCH=1.
//
// The two SKIP guards are independent: skipping the electron rebuild does NOT
// skip the aria2 fetch, and vice-versa — so a CI install that sets
// MOTRIX_SKIP_ELECTRON_REBUILD=1 still populates the aria2 binary that the
// bundledAria2Exists()-gated integration tests need. FAILURE, however, is not
// independent: if Stage A actually runs and fails, we short-circuit with its
// real exit code and never start the (network) Stage B — a broken native
// rebuild should surface immediately, not be masked by a later aria2 fetch. An
// unsupported host in Stage B (fetch-engine EXIT_UNSUPPORTED_HOST) is soft.

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EXIT_UNSUPPORTED_HOST,
  run as runFetchEngine,
} from './fetch-engine.mjs'

// Classify a spawnSync result into an exit code. A signal kill (status === null,
// signal set) must NEVER read as success — `result.status ?? 0` would have
// masked it. Only status === 0 is success.
export function classifyRebuildResult(result) {
  if (result.error) {
    return { code: 1, reason: `spawn error: ${result.error.message}` }
  }
  if (result.signal) {
    return { code: 1, reason: `killed by signal ${result.signal}` }
  }
  return { code: result.status ?? 1, reason: null }
}

export function runElectronRebuild(
  spawn = spawnSync,
  platform = process.platform
) {
  // On Windows the .bin entry is an `electron-rebuild.cmd` shim, which Node
  // refuses to spawn directly (ENOENT/EINVAL since CVE-2024-27980); route it
  // through cmd.exe. The argv is a fixed literal, so shell quoting is moot.
  // Invoke @electron/rebuild directly so the install-time rebuild targets the
  // repository root instead of loading electron-builder's staged appDir. The
  // staged app does not exist until after the build completes.
  const result = spawn(
    'electron-rebuild',
    ['--module-dir', '.', '--sequential', '--disable-pre-gyp-copy'],
    {
      stdio: 'inherit',
      shell: platform === 'win32',
    }
  )
  const { code, reason } = classifyRebuildResult(result)
  if (reason) console.error(`[postinstall] @electron/rebuild ${reason}`)
  return code
}

export const defaultDeps = {
  runElectronRebuild,
  runEngineFetch: () => runFetchEngine([]),
  log: (...parts) => console.log(...parts),
  logError: (...parts) => console.error(...parts),
}

export async function main(env, deps = defaultDeps) {
  // Stage A — electron rebuild (independent SKIP guard).
  if (env.MOTRIX_SKIP_ELECTRON_REBUILD === '1') {
    deps.log(
      '[postinstall] Stage A: skipping @electron/rebuild ' +
        '(MOTRIX_SKIP_ELECTRON_REBUILD=1)'
    )
  } else {
    const code = await deps.runElectronRebuild()
    if (code !== 0) {
      // Hard failure: surface the real exit code and do NOT proceed to the
      // network-bound Stage B.
      deps.logError(
        `[postinstall] Stage A (electron rebuild) failed (${code}) — ` +
          'aborting before aria2 fetch'
      )
      return code
    }
  }

  // Stage B — aria2 host fetch. Reached only when Stage A was skipped or
  // succeeded (its own independent SKIP guard still applies).
  if (env.MOTRIX_SKIP_ENGINE_FETCH === '1') {
    deps.log(
      '[postinstall] Stage B: skipping aria2 fetch (MOTRIX_SKIP_ENGINE_FETCH=1)'
    )
    return 0
  }
  const code = await deps.runEngineFetch()
  if (code !== 0 && code !== EXIT_UNSUPPORTED_HOST) {
    deps.logError(`[postinstall] Stage B (aria2 fetch) failed (${code})`)
    return code
  }
  return 0
}

const invokedAsMain =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedAsMain) {
  main(process.env)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[postinstall] fatal: ${err?.stack ?? err}`)
      process.exit(1)
    })
}
