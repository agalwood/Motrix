import type { Tray } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  construct: vi.fn(),
  render: vi.fn(),
  free: vi.fn(),
  imageFree: vi.fn(),
  asPng: vi.fn(),
  createImage: vi.fn(),
  warn: vi.fn(),
}))
vi.mock('node:fs', () => ({ readFileSync: () => Buffer.from([1, 2, 3]) }))
vi.mock('@core/logger', () => ({ getLogger: () => ({ warn: mocks.warn }) }))
vi.mock('electron', () => ({
  nativeImage: { createFromBuffer: mocks.createImage },
}))
vi.mock('@resvg/resvg-wasm', () => ({
  initWasm: mocks.init,
  Resvg: class {
    constructor(svg: string, options: unknown) {
      mocks.construct(svg, options)
    }
    render = mocks.render
    free = mocks.free
  },
}))

const handles: Array<{ destroy(): void }> = []
beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  vi.useFakeTimers()
  mocks.init.mockResolvedValue(undefined)
  mocks.construct.mockImplementation(() => ({
    render: mocks.render,
    free: mocks.free,
  }))
  mocks.render.mockReturnValue({ asPng: mocks.asPng, free: mocks.imageFree })
  mocks.asPng.mockReturnValue(new Uint8Array([1, 2, 3]))
  mocks.createImage.mockReturnValue({ setTemplateImage: vi.fn() })
})
afterEach(() => {
  for (const handle of handles.splice(0)) handle.destroy()
  vi.useRealTimers()
})
async function fixture() {
  const { createSpeedometer } = await import('./tray-speedometer')
  const tray = { setImage: vi.fn() }
  let current: typeof tray | null = tray
  const handle = createSpeedometer(
    () => current as unknown as Tray | null,
    '<path/>',
    '/assets'
  )
  handles.push(handle)
  handle.setEnabled(true)
  return {
    handle,
    tray,
    replaceTray: () => {
      current = { setImage: vi.fn() }
    },
  }
}
async function tick() {
  await vi.advanceTimersByTimeAsync(500)
  await vi.dynamicImportSettled()
}

it('releases both WASM allocations before native image creation and copies their bytes', async () => {
  const { handle, tray } = await fixture()
  const bytes = new Uint8Array([1, 2, 3])
  mocks.asPng.mockReturnValue(bytes)
  mocks.imageFree.mockImplementation(() => {
    bytes.fill(0)
  })
  mocks.createImage.mockImplementation((png) => {
    expect([...png]).toEqual([1, 2, 3])
    expect(mocks.imageFree).toHaveBeenCalledOnce()
    expect(mocks.free).toHaveBeenCalledOnce()
    return { setTemplateImage: vi.fn() }
  })
  handle.onSpeedChange(0, 1000)
  await tick()
  expect(tray.setImage).toHaveBeenCalledOnce()
})

it.each(['render', 'encode', 'native', 'publish'] as const)(
  'cleans up and retries after a %s failure',
  async (stage) => {
    const { handle, tray } = await fixture()
    const fail = () => {
      throw new Error('injected')
    }
    if (stage === 'render') mocks.render.mockImplementationOnce(fail)
    if (stage === 'encode') mocks.asPng.mockImplementationOnce(fail)
    if (stage === 'native') mocks.createImage.mockImplementationOnce(fail)
    if (stage === 'publish') tray.setImage.mockImplementationOnce(fail)
    handle.onSpeedChange(0, 1000)
    await tick()
    expect(mocks.free).toHaveBeenCalledOnce()
    expect(mocks.imageFree).toHaveBeenCalledTimes(stage === 'render' ? 0 : 1)
    handle.onSpeedChange(0, 1000)
    await tick()
    expect(mocks.free).toHaveBeenCalledTimes(2)
    expect(tray.setImage).toHaveBeenCalledTimes(stage === 'publish' ? 2 : 1)
  }
)

it.each(['destroy', 'disable', 'replace'] as const)(
  'does not publish after %s during initialization',
  async (action) => {
    const { handle, tray, replaceTray } = await fixture()
    let ready!: () => void
    mocks.init.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        ready = resolve
      })
    )
    handle.onSpeedChange(0, 1000)
    await tick()
    if (action === 'destroy') handle.destroy()
    if (action === 'disable') handle.setEnabled(false)
    if (action === 'replace') replaceTray()
    ready()
    await tick()
    expect(mocks.construct).not.toHaveBeenCalled()
    expect(tray.setImage).not.toHaveBeenCalled()
  }
)

it('shares initialization across handles and renders the latest unit after an invalidated frame', async () => {
  const { createSpeedometer } = await import('./tray-speedometer')
  let ready!: () => void
  mocks.init.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      ready = resolve
    })
  )
  const a = createSpeedometer(
    () => ({ setImage() {} }) as unknown as Tray,
    '<path/>',
    '/assets'
  )
  handles.push(a)
  // A stable tray reference is required for the async identity guard.
  const tray = { setImage: vi.fn() }
  const b = createSpeedometer(
    () => tray as unknown as Tray,
    '<path/>',
    '/assets'
  )
  handles.push(b)
  for (const handle of [a, b]) {
    handle.setEnabled(true)
    handle.onSpeedChange(0, 1048576)
  }
  await tick()
  b.setUnitSystem('binary')
  ready()
  await tick()
  await tick()
  expect(mocks.init).toHaveBeenCalledOnce()
  expect(mocks.construct.mock.calls.at(-1)?.[0]).toContain('1.00 MiB/s')
  expect(tray.setImage).toHaveBeenCalledOnce()
})

it('skips equal displayed speeds and retries a failed initializer', async () => {
  const { handle } = await fixture()
  mocks.init.mockRejectedValueOnce(new Error('bad WASM'))
  handle.onSpeedChange(0, 1000)
  await tick()
  expect(mocks.construct).not.toHaveBeenCalled()
  handle.onSpeedChange(0, 1000)
  await tick()
  expect(mocks.init).toHaveBeenCalledTimes(2)
  handle.onSpeedChange(0, 1001)
  await tick()
  expect(mocks.construct).toHaveBeenCalledOnce()
})
