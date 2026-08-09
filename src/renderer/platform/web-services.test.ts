import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __webPathPickerBus, createWebServices } from './web-services'

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
    __webPathPickerBus.subscribe(spy)
    const pending = services.pickSaveDir('/prev')
    expect(spy).toHaveBeenCalledWith({ defaultPath: '/prev' })
    __webPathPickerBus.resolve('/selected')
    expect(await pending).toBe('/selected')
  })

  it('pickSaveDir resolves null on cancel', async () => {
    const pending = services.pickSaveDir()
    __webPathPickerBus.resolve(null)
    expect(await pending).toBeNull()
  })

  it('readClipboard returns empty on permission denial', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    })
    expect(await services.readClipboard()).toBe('')
  })
})
