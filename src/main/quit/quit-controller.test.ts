import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type QuitConfirmResult,
  QuitController,
  type QuitControllerDeps,
} from './quit-controller'

const flush = () => new Promise<void>((r) => setTimeout(r, 0))

function makeDeps(over: Partial<QuitControllerDeps> = {}): QuitControllerDeps {
  return {
    getWarnBeforeQuit: vi.fn(() => true),
    getActiveCount: vi.fn(() => 1),
    confirm: vi.fn(
      async (): Promise<QuitConfirmResult> => ({
        confirmed: true,
        dontAskAgain: false,
      })
    ),
    persistDisableWarn: vi.fn(async () => {}),
    beginShutdown: vi.fn(),
    ...over,
  }
}

describe('QuitController', () => {
  let deps: QuitControllerDeps
  beforeEach(() => {
    deps = makeDeps()
  })

  it('shuts down without confirming when warnBeforeQuit is false', () => {
    deps = makeDeps({ getWarnBeforeQuit: vi.fn(() => false) })
    const c = new QuitController(deps)
    c.requestQuit()
    expect(deps.confirm).not.toHaveBeenCalled()
    expect(deps.beginShutdown).toHaveBeenCalledTimes(1)
    expect(c.phase).toBe('shutting-down')
  })

  it('shuts down without confirming when no downloads are active', () => {
    deps = makeDeps({ getActiveCount: vi.fn(() => 0) })
    const c = new QuitController(deps)
    c.requestQuit()
    expect(deps.confirm).not.toHaveBeenCalled()
    expect(deps.beginShutdown).toHaveBeenCalledTimes(1)
  })

  it('bypasses the dialog after markForceQuit', () => {
    const c = new QuitController(deps)
    c.markForceQuit()
    c.requestQuit()
    expect(deps.confirm).not.toHaveBeenCalled()
    expect(deps.beginShutdown).toHaveBeenCalledTimes(1)
  })

  it('starts an idempotent forced shutdown for termination signals', () => {
    const c = new QuitController(deps)

    c.requestForcedQuit()
    c.requestForcedQuit()
    c.requestQuit()

    expect(deps.confirm).not.toHaveBeenCalled()
    expect(deps.beginShutdown).toHaveBeenCalledTimes(1)
    expect(c.phase).toBe('shutting-down')
  })

  it('supersedes a pending confirmation with forced shutdown', async () => {
    let resolveConfirmation!: (result: QuitConfirmResult) => void
    deps = makeDeps({
      confirm: vi.fn(
        () =>
          new Promise<QuitConfirmResult>((resolve) => {
            resolveConfirmation = resolve
          })
      ),
    })
    const c = new QuitController(deps)

    c.requestQuit()
    c.requestForcedQuit()
    resolveConfirmation({ confirmed: true, dontAskAgain: true })
    await flush()

    expect(deps.persistDisableWarn).not.toHaveBeenCalled()
    expect(deps.beginShutdown).toHaveBeenCalledTimes(1)
  })

  it('bypasses the dialog after markSessionEnding', () => {
    const c = new QuitController(deps)
    c.markSessionEnding()
    c.requestQuit()
    expect(deps.confirm).not.toHaveBeenCalled()
    expect(deps.beginShutdown).toHaveBeenCalledTimes(1)
  })

  it('on cancel returns to idle and touches nothing', async () => {
    deps = makeDeps({
      confirm: vi.fn(async () => ({ confirmed: false, dontAskAgain: false })),
    })
    const c = new QuitController(deps)
    c.requestQuit()
    expect(c.phase).toBe('confirming')
    await flush()
    expect(deps.beginShutdown).not.toHaveBeenCalled()
    expect(deps.persistDisableWarn).not.toHaveBeenCalled()
    expect(c.phase).toBe('idle')
  })

  it('on confirm shuts down once and reads the active count once', async () => {
    const c = new QuitController(deps)
    c.requestQuit()
    await flush()
    expect(deps.getActiveCount).toHaveBeenCalledTimes(1)
    expect(deps.beginShutdown).toHaveBeenCalledTimes(1)
    expect(c.phase).toBe('shutting-down')
  })

  it('persists the disable flag before shutting down when checkbox is set', async () => {
    const order: string[] = []
    deps = makeDeps({
      confirm: vi.fn(async () => ({ confirmed: true, dontAskAgain: true })),
      persistDisableWarn: vi.fn(async () => {
        order.push('persist')
      }),
      beginShutdown: vi.fn(() => {
        order.push('shutdown')
      }),
    })
    const c = new QuitController(deps)
    c.requestQuit()
    await flush()
    expect(deps.persistDisableWarn).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['persist', 'shutdown'])
  })

  it('fails open: shuts down if confirm rejects', async () => {
    deps = makeDeps({
      confirm: vi.fn(async () => {
        throw new Error('no display')
      }),
    })
    const c = new QuitController(deps)
    c.requestQuit()
    await flush()
    expect(deps.beginShutdown).toHaveBeenCalledTimes(1)
  })

  it('fails open: shuts down if persistDisableWarn rejects', async () => {
    deps = makeDeps({
      confirm: vi.fn(async () => ({ confirmed: true, dontAskAgain: true })),
      persistDisableWarn: vi.fn(async () => {
        throw new Error('disk full')
      }),
    })
    const c = new QuitController(deps)
    c.requestQuit()
    await flush()
    expect(deps.beginShutdown).toHaveBeenCalledTimes(1)
  })
})
