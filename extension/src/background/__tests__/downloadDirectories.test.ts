import { describe, expect, it, vi } from 'vitest'
import { createDownloadDirectoriesHandler } from '@/background/downloadDirectories'

function fixture() {
  const sender = {
    id: 'extension',
    url: 'chrome-extension://extension/popup.html',
  }
  const assertCurrent = vi.fn()
  const manager = {
    getState: vi.fn(() => 'connected' as const),
    getServerIdentity: vi.fn(() => ({
      name: 'Motrix',
      version: '2',
      runtime: 'electron' as const,
      instanceId: 'instance-a',
    })),
    getServerCapabilities: vi.fn(() => ({
      ffmpegAvailable: false,
      selectionKinds: ['direct'],
      taskReveal: false,
      downloadDirectories: true,
    })),
    request: vi.fn(async () => ({
      defaultSaveDir: '/downloads',
      favorites: ['/movies'],
      recent: [],
    })),
  }
  const handler = createDownloadDirectoriesHandler({
    extensionId: 'extension',
    extensionBaseUrl: 'chrome-extension://extension/',
    captureGuard: async () => ({
      origin: 'context-menu',
      endpointId: 'local',
      endpointRevision: 0,
      assertCurrent,
    }),
    manager: manager as never,
  })
  return { sender, handler, manager, assertCurrent }
}
describe('private directory queries', () => {
  it('returns paths bound to the authenticated target', async () => {
    const f = fixture()
    expect(await f.handler(undefined, f.sender)).toMatchObject({
      status: 'ready',
      binding: {
        endpointId: 'local',
        endpointRevision: 0,
        instanceId: 'instance-a',
      },
    })
  })
  it.each([
    { id: 'extension', url: 'https://example.test/', tab: {} },
    { id: 'other', url: 'chrome-extension://extension/popup.html' },
  ])('rejects content scripts and foreign callers', async (sender) => {
    const f = fixture()
    await expect(f.handler(undefined, sender)).rejects.toThrow(
      'download.rejected'
    )
    expect(f.manager.request).not.toHaveBeenCalled()
  })
  it('does not query older hosts', async () => {
    const f = fixture()
    f.manager.getServerCapabilities.mockReturnValue({
      ffmpegAvailable: false,
      selectionKinds: ['direct'],
      taskReveal: false,
      downloadDirectories: false,
    })
    expect(await f.handler(undefined, f.sender)).toEqual({
      status: 'unsupported',
    })
    expect(f.manager.request).not.toHaveBeenCalled()
  })
  it('drops stale responses after an endpoint switch or instance replacement', async () => {
    const f = fixture()
    f.assertCurrent
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('changed')
      })
    expect(await f.handler(undefined, f.sender)).toEqual({
      status: 'unavailable',
    })
    f.assertCurrent.mockReset()
    f.manager.getServerIdentity.mockReturnValueOnce({
      name: 'Motrix',
      version: '2',
      runtime: 'electron',
      instanceId: 'old-instance',
    })
    expect(await f.handler(undefined, f.sender)).toEqual({
      status: 'unavailable',
    })
  })
  it('hides malformed results and transport errors', async () => {
    const f = fixture()
    f.manager.request.mockResolvedValueOnce({
      defaultSaveDir: '/secret\0path',
      favorites: [],
      recent: [],
    })
    expect(await f.handler(undefined, f.sender)).toEqual({
      status: 'unavailable',
    })
    f.manager.request.mockRejectedValueOnce(new Error('/private/error'))
    expect(await f.handler(undefined, f.sender)).toEqual({
      status: 'unavailable',
    })
  })
})
