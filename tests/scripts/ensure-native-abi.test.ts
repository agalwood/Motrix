import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — .mjs without types
import { decideAbi, probeRuntime } from '../../scripts/ensure-native-abi.mjs'

type Decision = 'match' | 'mismatch' | 'missing' | 'unknown'

const probe = (
  over: Partial<{
    status: number | null
    signal: NodeJS.Signals | null
    stderr: string
  }>
) => ({
  status: over.status ?? null,
  signal: over.signal ?? null,
  stderr: over.stderr ?? '',
})

// The probe runs UNDER THE TARGET RUNTIME, so a clean load proves the binary
// matches that runtime's exact ABI — not merely "some electron". A
// NODE_MODULE_VERSION error therefore always means rebuild, regardless of
// which runtime we targeted.
describe('decideAbi (target-relative)', () => {
  it('returns "match" when the binary loads cleanly under the target runtime', () => {
    expect(decideAbi(probe({ status: 0 })) satisfies Decision).toBe('match')
  })

  it('returns "mismatch" on a NODE_MODULE_VERSION error (stale/wrong ABI)', () => {
    expect(
      decideAbi(
        probe({
          status: 3,
          stderr:
            'Error [ERR_DLOPEN_FAILED]: ... was compiled against a different Node.js version using NODE_MODULE_VERSION 141. This version of Node.js requires NODE_MODULE_VERSION 146.',
        })
      )
    ).toBe('mismatch')
  })

  it('returns "missing" when probe reports MODULE_NOT_FOUND', () => {
    expect(
      decideAbi(
        probe({ status: 4, stderr: "Cannot find module 'better-sqlite3'" })
      )
    ).toBe('missing')
  })

  it('returns "unknown" when probe is killed by SIGKILL (AMFI / kernel reject)', () => {
    expect(decideAbi(probe({ signal: 'SIGKILL' }))).toBe('unknown')
  })

  it('returns "unknown" for exit code 137 (raw SIGKILL exit)', () => {
    expect(decideAbi(probe({ status: 137 }))).toBe('unknown')
  })

  it('returns "unknown" for any other unrecognized failure', () => {
    expect(decideAbi(probe({ status: 1, stderr: 'something weird' }))).toBe(
      'unknown'
    )
  })
})

// The fix's core: distinguishing "built for THIS electron" from "built for a
// DIFFERENT electron" requires loading the binary under the electron runtime
// itself, not under the host node. probeRuntime selects that runtime.
describe('probeRuntime', () => {
  it('runs the probe under the electron binary (run-as-node) for the electron target', () => {
    const r = probeRuntime('electron')
    expect(r.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(r.command).not.toBe(process.execPath)
    expect(r.command.toLowerCase()).toContain('electron')
  })

  it('runs the probe under the current node for the node target', () => {
    const r = probeRuntime('node')
    expect(r.command).toBe(process.execPath)
    expect(r.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })
})

describe('ensure-native-abi.mjs subprocess probe', () => {
  it('does not crash the parent when the child is killed by signal', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const script = path.resolve(here, '../../scripts/ensure-native-abi.mjs')
    const r = spawnSync(
      process.execPath,
      [
        '-e',
        `const {spawnSync}=require('node:child_process');
         const probe=spawnSync(process.execPath,['-e','process.kill(process.pid, "SIGKILL")']);
         process.stdout.write(JSON.stringify({status:probe.status,signal:probe.signal}));`,
      ],
      { encoding: 'utf8' }
    )
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.signal).toBe('SIGKILL')
    expect(typeof script).toBe('string')
  })
})
