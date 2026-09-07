import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __webPathPickerBus,
  createWebServices,
  PathPickerBus,
} from './web-services'

describe('createWebServices', () => {
  let services: ReturnType<typeof createWebServices>

  beforeEach(() => {
    services = createWebServices()
  })

  it('kind is web', () => {
    expect(services.kind).toBe('web')
  })

  it('pickSaveDir emits on bus and resolves on response', async () => {
    const spy = vi.fn()
    const unsubscribe = __webPathPickerBus.subscribe(spy)
    const pending = services.pickSaveDir('/prev')
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: '/prev', id: expect.any(Number) })
    )
    __webPathPickerBus.resolve(spy.mock.calls[0][0].id, '/selected')
    expect(await pending).toBe('/selected')
    unsubscribe()
  })

  it('pickSaveDir resolves null on cancel', async () => {
    const spy = vi.fn()
    const unsubscribe = __webPathPickerBus.subscribe(spy)
    const pending = services.pickSaveDir()
    __webPathPickerBus.resolve(spy.mock.calls[0][0].id, null)
    expect(await pending).toBeNull()
    unsubscribe()
  })

  it('readClipboard returns empty on permission denial', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    })
    expect(await services.readClipboard()).toBe('')
  })

  it('uploads a selected plugin and returns an opaque Server reference', async () => {
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            uploadId: '123e4567-e89b-42d3-a456-426614174000',
            fileHash: 'b'.repeat(64),
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        )
      )
    ) as unknown as typeof fetch
    services = createWebServices({
      fetchImpl,
      baseUrl: 'http://motrix.lan:8080',
    })
    const file = new File(['plugin'], '插件.moext')

    await expect(services.pluginInstallFile?.prepare(file)).resolves.toEqual({
      sourceType: 'upload',
      uploadId: '123e4567-e89b-42d3-a456-426614174000',
      fileHash: 'b'.repeat(64),
    })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://motrix.lan:8080/api/plugins/uploads',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: file,
        headers: {
          'content-type': 'application/vnd.motrix.moext',
          'x-motrix-file-name': encodeURIComponent('插件.moext'),
        },
      })
    )
  })

  it('surfaces a rejected upload instead of fabricating a path', async () => {
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(new Response('too large', { status: 413 }))
    ) as unknown as typeof fetch
    services = createWebServices({ fetchImpl, baseUrl: '' })
    await expect(
      services.pluginInstallFile?.prepare(new File(['x'], 'x.moext'))
    ).rejects.toThrow('Plugin upload failed (413)')
  })
})

describe('PathPickerBus session ownership', () => {
  it('settles a no-host request without leaving a pending promise', async () => {
    await expect(new PathPickerBus().request({})).resolves.toBeNull()
  })

  it('rejects stale resolution and focus restoration after supersession', async () => {
    const bus = new PathPickerBus()
    const listener = vi.fn()
    const unsubscribe = bus.subscribe(listener)
    const a = bus.request({ defaultPath: '/a' })
    const aId = listener.mock.calls[0][0].id
    const b = bus.request({ defaultPath: '/b' })
    const bId = listener.mock.calls[1][0].id
    await expect(a).resolves.toBeNull()
    bus.resolve(aId, '/stale')
    expect(bus.canRestoreFocus(aId)).toBe(false)
    expect(bus.canRestoreFocus(bId)).toBe(false)
    bus.resolve(bId, '/b')
    await expect(b).resolves.toBe('/b')
    expect(bus.canRestoreFocus(bId)).toBe(true)
    unsubscribe()
  })

  it('captures the opener synchronously and settles when the host unmounts', async () => {
    const bus = new PathPickerBus()
    const opener = document.createElement('button')
    document.body.append(opener)
    opener.focus()
    const listener = vi.fn()
    const unsubscribe = bus.subscribe(listener)
    const pending = bus.request({})
    expect(listener.mock.calls[0][0].opener).toBe(opener)
    unsubscribe()
    await expect(pending).resolves.toBeNull()
    opener.remove()
  })
})
