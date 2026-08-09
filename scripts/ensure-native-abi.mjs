#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Classify a probe that was run UNDER THE TARGET RUNTIME (see probeRuntime).
// Because the probe loads the binary with the very runtime we are about to
// ship/use, a clean exit proves the ABI matches *that exact runtime* — not
// merely "some electron". So a NODE_MODULE_VERSION error always means the
// binary was built for a different ABI and must be rebuilt, no matter the
// target. This is the fix for the version-blind bug where a binary built for
// an older electron was mistaken for "already compiled for electron".
//   probe: { status: number | null, signal: NodeJS.Signals | null, stderr: string }
export function decideAbi(probe) {
  if (probe.signal != null) return 'unknown'
  if (probe.status === 0) return 'match'
  if (probe.status === 137) return 'unknown'
  const stderr = probe.stderr ?? ''
  if (/Cannot find module/.test(stderr) || /MODULE_NOT_FOUND/.test(stderr)) {
    return 'missing'
  }
  if (/NODE_MODULE_VERSION/.test(stderr)) return 'mismatch'
  return 'unknown'
}

const NATIVE_PATH = path.resolve(
  'node_modules/better-sqlite3/build/Release/better_sqlite3.node'
)

const PROBE_SCRIPT = fileURLToPath(import.meta.url)

// Pick the runtime the probe child runs under. The whole point is to load the
// binary with the SAME runtime we are targeting, so a clean load proves the
// ABI matches that runtime's exact version:
//   - electron: run the bundled electron binary as node (ELECTRON_RUN_AS_NODE)
//     so the probe sees electron's current ABI (e.g. NMV 146 for Electron 42).
//   - node: the host node we are already in.
// This is what makes detection version-aware: a binary built for an *older*
// electron now fails the electron probe instead of being mistaken for "ready".
export function probeRuntime(target) {
  if (target === 'electron') {
    const require = createRequire(import.meta.url)
    // require('electron') in a node context resolves to the electron binary.
    const electronBin = require('electron')
    return {
      command: electronBin,
      args: [PROBE_SCRIPT, '--probe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    }
  }
  return {
    command: process.execPath,
    args: [PROBE_SCRIPT, '--probe'],
    env: process.env,
  }
}

function probe(target) {
  // Run the actual dlopen in a SUBPROCESS so a kernel-level SIGKILL
  // (macOS AMFI rejecting a stale .node) cannot take down the parent.
  // The child requires better-sqlite3 and instantiates a Database to
  // force the native bindings to load — `require` alone only loads the
  // JS wrapper.
  const { command, args, env } = probeRuntime(target)
  return spawnSync(command, args, { encoding: 'utf8', env })
}

function removeStaleBinary() {
  // Drop the existing .node so the rebuild can never reuse a cached artifact
  // and the kernel re-evaluates a fresh inode. @electron/rebuild's own
  // `.forge-meta` marker has been observed to claim a newer ABI than the
  // binary actually has, so we never trust it — we delete and rebuild.
  if (!existsSync(NATIVE_PATH)) return
  try {
    unlinkSync(NATIVE_PATH)
  } catch (err) {
    console.warn(
      `[ensure-native-abi] could not remove ${NATIVE_PATH}: ${err?.message ?? err}`
    )
  }
}

function rebuild(target) {
  const cmd =
    target === 'node'
      ? ['pnpm', ['rebuild', 'better-sqlite3']]
      : [
          'pnpm',
          ['exec', 'electron-rebuild', '--force', '--only', 'better-sqlite3'],
        ]
  const r = spawnSync(cmd[0], cmd[1], { stdio: 'inherit' })
  if (r.error) {
    console.error(`[ensure-native-abi] failed to spawn ${cmd[0]}:`, r.error)
    return 1
  }
  return r.status ?? 0
}

function runMain() {
  const target = process.argv[2]

  if (target === '--probe') {
    try {
      const require = createRequire(import.meta.url)
      const Database = require('better-sqlite3')
      const db = new Database(':memory:')
      db.close()
      process.exit(0)
    } catch (err) {
      const msg = String(err?.message ?? err)
      process.stderr.write(`${err?.code ?? 'ERR'}: ${msg}\n`)
      if (err?.code === 'MODULE_NOT_FOUND') process.exit(4)
      if (err?.code === 'ERR_DLOPEN_FAILED') process.exit(3)
      process.exit(5)
    }
  }

  if (target !== 'node' && target !== 'electron') {
    console.error(
      '[ensure-native-abi] usage: ensure-native-abi.mjs <node|electron>'
    )
    process.exit(2)
  }

  const detected = decideAbi(probe(target))

  if (detected === 'missing') {
    console.error(
      '[ensure-native-abi] better-sqlite3 not installed — run pnpm install first'
    )
    process.exit(1)
  }

  if (detected === 'match') {
    console.log(
      `[ensure-native-abi] better-sqlite3 already compiled for ${target} — skipping`
    )
    process.exit(0)
  }

  if (detected === 'unknown') {
    // Probe child was killed without a parseable error (most commonly a
    // macOS AMFI SIGKILL on dlopen, which leaves no JS-catchable trace).
    console.warn(
      '[ensure-native-abi] probe terminated abnormally — likely a stale or ' +
        `kernel-rejected .node; rebuilding for ${target}`
    )
  } else {
    // detected === 'mismatch' — built for a different ABI than the target.
    console.log(
      `[ensure-native-abi] better-sqlite3 ABI does not match the ${target} ` +
        'runtime, rebuilding...'
    )
  }

  removeStaleBinary()
  process.exit(rebuild(target))
}

// CLI guard — only run when invoked directly, not when imported by tests.
const invokedAsMain =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedAsMain) {
  runMain()
}
