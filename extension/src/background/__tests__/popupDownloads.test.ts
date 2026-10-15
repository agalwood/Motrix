import { webcrypto } from 'node:crypto'
import type { DownloadSubmitParams } from '@motrix/mdxp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaCredentialStore } from '@/background/capture/MediaCredentialStore'
import { DownloadSubmissionService } from '@/background/DownloadSubmissionService'
import { MediaStore } from '@/background/MediaStore'
import { createPopupDownloadHandlers } from '@/background/popupDownloads'
import type { Browser } from '@/shared/browser'
import { newDownloadOperationId } from '@/shared/integration'
import { mediaStorageKey } from '@/shared/media'

const sender = {
  id: 'extension-id',
  url: 'chrome-extension://extension-id/popup.html',
}
const media = {
  kind: 'hls' as const,
  url: 'https://cdn.example/master.m3u8',
  pageUrl: 'https://www.youtube.com/watch?v=motrix',
  pageTitle: 'Watch',
  detectedAt: 1,
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fixture() {
  const ready = deferred()
  let online = false
  const manager = {
    ensureReady: vi.fn(async () => {
      await ready.promise
      online = true
    }),
    clearGateAndStart: vi.fn(async () => {}),
    getServerCapabilities: vi.fn(() =>
      online
        ? {
            selectionKinds: ['direct', 'hls'],
            ffmpegAvailable: true,
            taskReveal: false,
          }
        : null
    ),
    submitDownload: vi.fn(
      async (
        _params: DownloadSubmitParams,
        options: {
          onSubmitting?: () => Promise<void>
          assertCurrent?: () => void
        } = {}
      ) => {
        await options.onSubmitting?.()
        options.assertCurrent?.()
        return { taskId: 'task-1' }
      }
    ),
  }
  const submissions = new DownloadSubmissionService({
    manager,
    isPaired: async () => true,
    captureGuard: async () => ({
      endpointId: 'local',
      endpointRevision: 0,
      origin: 'context-menu',
      assertCurrent: () => {},
    }),
  })
  const mediaStore = new MediaStore()
  await mediaStore.add(4, [media])
  const mediaCredentialStore = new MediaCredentialStore()
  const observation = vi.spyOn(mediaCredentialStore, 'get')
  const getActiveTabs = vi.fn(async () => [
    { id: 4, url: media.pageUrl, title: 'Watch' } as Browser.tabs.Tab,
  ])
  const cookieApi = { getAll: vi.fn(async () => []) }
  const handlers = createPopupDownloadHandlers({
    manager,
    submissions,
    mediaStore,
    mediaCredentialStore,
    getActiveTabs,
    cookieApi,
    extensionId: sender.id,
    extensionBaseUrl: 'chrome-extension://extension-id/',
    browserKind: 'chromium',
    userAgent: 'test-browser',
    webStore: false,
  })
  return { handlers, ready, manager, getActiveTabs, cookieApi, observation }
}
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  const values: Record<string, unknown> = {}
  browser.storage.session.get = vi.fn(async (key: string) => ({
    [key]: values[key],
  })) as never
  browser.storage.session.set = vi.fn(
    async (items: Record<string, unknown>) => {
      Object.assign(values, items)
    }
  )
})
afterEach(() => vi.unstubAllGlobals())

describe('production popup download handlers', () => {
  it('waits for readiness before reading HLS capabilities and credentials', async () => {
    const f = await fixture()
    const operation = f.handlers.submitMedia(
      {
        idempotencyKey: newDownloadOperationId(),
        mediaKey: mediaStorageKey(media),
      },
      sender
    )
    await vi.waitFor(() => expect(f.manager.ensureReady).toHaveBeenCalledOnce())
    expect(f.manager.getServerCapabilities).not.toHaveBeenCalled()
    expect(f.observation).not.toHaveBeenCalled()
    f.ready.resolve()
    await expect(operation).resolves.toEqual({ taskId: 'task-1' })
    expect(f.manager.submitDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: expect.objectContaining({ kind: 'hls' }),
      }),
      expect.anything()
    )
  })
  it('captures page cookies after wake and preserves the original watch URL', async () => {
    const f = await fixture()
    const operation = f.handlers.resolvePageDownload(
      { idempotencyKey: newDownloadOperationId() },
      sender
    )
    await vi.waitFor(() => expect(f.manager.ensureReady).toHaveBeenCalledOnce())
    expect(f.cookieApi.getAll).not.toHaveBeenCalled()
    f.ready.resolve()
    await expect(operation).resolves.toEqual({ taskId: 'task-1' })
    expect(f.cookieApi.getAll).toHaveBeenCalledWith({ url: media.pageUrl })
    expect(f.manager.submitDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ pageUrl: media.pageUrl }),
      }),
      expect.anything()
    )
  })
  it.each(['media', 'page'] as const)(
    'rejects a changed active tab after wake for %s',
    async (source) => {
      const f = await fixture()
      const operation =
        source === 'media'
          ? f.handlers.submitMedia(
              {
                idempotencyKey: newDownloadOperationId(),
                mediaKey: mediaStorageKey(media),
              },
              sender
            )
          : f.handlers.resolvePageDownload(
              { idempotencyKey: newDownloadOperationId() },
              sender
            )
      const rejected = expect(operation).rejects.toThrow(
        'download.context-changed'
      )
      await vi.waitFor(() =>
        expect(f.manager.ensureReady).toHaveBeenCalledOnce()
      )
      f.getActiveTabs.mockResolvedValue([
        { id: 5, url: media.pageUrl } as Browser.tabs.Tab,
      ])
      f.ready.resolve()
      await rejected
      expect(f.manager.submitDownload).not.toHaveBeenCalled()
    }
  )
  it('rejects content-script intents before any lookup or App wake', async () => {
    const f = await fixture()
    const contentSender = { ...sender, tab: { id: 4 } as Browser.tabs.Tab }
    await expect(
      f.handlers.resolvePageDownload(
        { idempotencyKey: newDownloadOperationId(), pairIfNeeded: true },
        contentSender
      )
    ).rejects.toThrow('media-submit.invalid-request')
    await expect(
      f.handlers.submitMedia(
        {
          idempotencyKey: newDownloadOperationId(),
          mediaKey: mediaStorageKey(media),
        },
        contentSender
      )
    ).rejects.toThrow('media-submit.invalid-request')
    expect(f.getActiveTabs).not.toHaveBeenCalled()
    expect(f.manager.ensureReady).not.toHaveBeenCalled()
    expect(f.manager.clearGateAndStart).not.toHaveBeenCalled()
  })
})
