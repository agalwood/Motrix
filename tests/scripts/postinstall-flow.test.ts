import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error — .mjs without types
import {
  classifyRebuildResult,
  main,
  runElectronRebuild,
} from '../../scripts/postinstall.mjs'

// Stage A (electron rebuild) and Stage B (aria2 fetch) are injected so the
// test observes control flow without spawning the rebuild tool or hitting the
// network. These assertions codify rev-2 constraint 5 plus the code-review
// fixes: the two SKIP guards are independent, but a Stage A FAILURE
// short-circuits with its real exit code and never starts the network Stage B.
function makeDeps() {
  return {
    runElectronRebuild: vi.fn(async () => 0),
    runEngineFetch: vi.fn(async () => 0),
    log: () => {},
    logError: () => {},
  }
}

describe('classifyRebuildResult', () => {
  it('treats status 0 as success', () => {
    expect(classifyRebuildResult({ status: 0 }).code).toBe(0)
  })

  it('treats a signal kill (status null) as failure, never success', () => {
    const r = classifyRebuildResult({ status: null, signal: 'SIGKILL' })
    expect(r.code).not.toBe(0)
    expect(r.reason).toMatch(/SIGKILL/)
  })

  it('propagates a non-zero status', () => {
    expect(classifyRebuildResult({ status: 2 }).code).toBe(2)
  })

  it('treats a spawn error as failure', () => {
    const r = classifyRebuildResult({ error: new Error('ENOENT') })
    expect(r.code).not.toBe(0)
    expect(r.reason).toMatch(/spawn error/)
  })
})

describe('runElectronRebuild', () => {
  it('rebuilds root dependencies without loading the staged app config', () => {
    const spawn = vi.fn(() => ({ status: 0 }))

    expect(runElectronRebuild(spawn, 'linux')).toBe(0)
    expect(spawn).toHaveBeenCalledWith(
      'electron-rebuild',
      ['--module-dir', '.', '--sequential', '--disable-pre-gyp-copy'],
      { stdio: 'inherit', shell: false }
    )
  })

  it('uses the command shell for the Windows shim', () => {
    const spawn = vi.fn(() => ({ status: 0 }))

    expect(runElectronRebuild(spawn, 'win32')).toBe(0)
    expect(spawn).toHaveBeenCalledWith(
      'electron-rebuild',
      ['--module-dir', '.', '--sequential', '--disable-pre-gyp-copy'],
      { stdio: 'inherit', shell: true }
    )
  })
})

describe('postinstall main flow', () => {
  it('runs both stages when neither skip var is set', async () => {
    const deps = makeDeps()
    expect(await main({}, deps)).toBe(0)
    expect(deps.runElectronRebuild).toHaveBeenCalledTimes(1)
    expect(deps.runEngineFetch).toHaveBeenCalledTimes(1)
  })

  it('MOTRIX_SKIP_ELECTRON_REBUILD=1 skips Stage A but STILL runs Stage B', async () => {
    const deps = makeDeps()
    expect(await main({ MOTRIX_SKIP_ELECTRON_REBUILD: '1' }, deps)).toBe(0)
    expect(deps.runElectronRebuild).not.toHaveBeenCalled()
    expect(deps.runEngineFetch).toHaveBeenCalledTimes(1)
  })

  it('MOTRIX_SKIP_ENGINE_FETCH=1 skips Stage B but STILL runs Stage A', async () => {
    const deps = makeDeps()
    expect(await main({ MOTRIX_SKIP_ENGINE_FETCH: '1' }, deps)).toBe(0)
    expect(deps.runElectronRebuild).toHaveBeenCalledTimes(1)
    expect(deps.runEngineFetch).not.toHaveBeenCalled()
  })

  it('the two skip vars are independent — setting both skips both', async () => {
    const deps = makeDeps()
    const env = {
      MOTRIX_SKIP_ELECTRON_REBUILD: '1',
      MOTRIX_SKIP_ENGINE_FETCH: '1',
    }
    expect(await main(env, deps)).toBe(0)
    expect(deps.runElectronRebuild).not.toHaveBeenCalled()
    expect(deps.runEngineFetch).not.toHaveBeenCalled()
  })

  it('a genuine Stage B failure returns its real exit code', async () => {
    const deps = makeDeps()
    deps.runEngineFetch = vi.fn(async () => 1)
    expect(await main({}, deps)).toBe(1)
  })

  it('an unsupported host in Stage B (exit 3) is soft — install still ok', async () => {
    const deps = makeDeps()
    deps.runEngineFetch = vi.fn(async () => 3)
    expect(await main({}, deps)).toBe(0)
  })

  it('a Stage A failure short-circuits: real exit code, Stage B NOT run', async () => {
    const deps = makeDeps()
    deps.runElectronRebuild = vi.fn(async () => 2)
    expect(await main({}, deps)).toBe(2)
    expect(deps.runEngineFetch).not.toHaveBeenCalled()
  })
})
