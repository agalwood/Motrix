// @vitest-environment node
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  build: vi.fn(),
  createServer: vi.fn(),
  process: { env: {}, on: vi.fn(), exit: vi.fn() },
}))

vi.mock('cross-spawn', () => ({ default: mocks.spawn }))
vi.mock('vite', () => ({
  build: mocks.build,
  createServer: mocks.createServer,
}))
vi.mock('node:process', () => ({ default: mocks.process }))
vi.mock('node:module', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:module')>()),
  createRequire: () => () => '/test/electron',
}))

const builds = new Map<string, () => void>()
let builtinProcess: EventEmitter
let electronProcess: EventEmitter & {
  connected: boolean
  send: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  builds.clear()
  builtinProcess = new EventEmitter()
  electronProcess = Object.assign(new EventEmitter(), {
    connected: true,
    send: vi.fn(),
  })
  mocks.spawn.mockImplementation((_command, args) =>
    args.includes('build:builtin') ? builtinProcess : electronProcess
  )
  mocks.createServer.mockResolvedValue({ listen: vi.fn() })
  mocks.build.mockImplementation(async (options) => {
    builds.set(
      path.basename(options.configFile),
      options.plugins[0].writeBundle
    )
  })
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('Electron development runner', () => {
  it('waits for the plugin worker build and restarts Electron when it changes', async () => {
    // @ts-expect-error — .mjs without types
    await import('../../scripts/dev.mjs')
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    builtinProcess.emit('exit', 0)
    await vi.waitFor(() => expect(mocks.build).toHaveBeenCalledTimes(3))

    builds.get('vite.main.config.ts')!()
    builds.get('vite.preload.config.ts')!()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.spawn).toHaveBeenCalledTimes(1)

    // A rebuild of an already-ready bundle cannot bypass the startup gate.
    builds.get('vite.main.config.ts')!()
    await vi.advanceTimersByTimeAsync(200)
    expect(mocks.spawn).toHaveBeenCalledTimes(1)

    builds.get('vite.worker.config.ts')!()
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    expect(mocks.spawn).toHaveBeenLastCalledWith(
      '/test/electron',
      ['.'],
      expect.any(Object)
    )

    builds.get('vite.worker.config.ts')!()
    await vi.advanceTimersByTimeAsync(200)
    expect(electronProcess.send).toHaveBeenCalledWith(
      'motrix:dev-shutdown',
      expect.any(Function)
    )
    electronProcess.emit('exit', 0)
    expect(mocks.spawn).toHaveBeenCalledTimes(3)
  })
})
