import { beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeTarget } from '@/background/capture/normalizeTarget'
import { requestConfirmedDownload } from '@/background/confirmedDownload'
import { createContextMenuDownloadRunner } from '@/background/contextMenu/download'
import { DownloadConfirmationService } from '@/background/DownloadConfirmationService'
import { DownloadSubmissionService } from '@/background/DownloadSubmissionService'
import {
  DownloadOutcomeUnknownError,
  DownloadPreparationError,
} from '@/background/download-errors'
import { extensionBrowser } from '@/shared/browser'
import { DOWNLOAD_ERROR } from '@/shared/integration'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'

function fixture() {
  const present = vi.fn(async () => {})
  const guard = {
    origin: 'context-menu' as const,
    endpointId: 'nas',
    endpointRevision: 2,
    assertCurrent: vi.fn(),
  }
  const deps = {
    popup: { captureSubmission: vi.fn(() => present) },
    getConfig: vi.fn(async () => TAKEOVER_DEFAULT),
    ready: vi.fn(async () => {}),
    captureGuard: vi.fn(async () => guard),
    manager: {
      getState: () => 'connected' as const,
      ensureReady: vi.fn(async () => {}),
      getLastError: () => null,
      getRpcStatus: () => ({ health: 'healthy' }),
      submitDownload: vi.fn(async () => ({ taskId: 'right-click-task' })),
    },
    isPaired: async () => true,
    gate: {},
    nudge: {},
    notify: vi.fn(),
  }
  return {
    present,
    deps,
    guard,
    run: createContextMenuDownloadRunner(deps as never),
  }
}

beforeEach(() => {
  Object.assign(extensionBrowser, {
    cookies: { getAll: vi.fn(async () => []) },
    downloads: { download: vi.fn(async () => 1) },
  })
})

describe('context menu download presentation', () => {
  it.each(['https://example.com/file.zip', 'magnet:?xt=urn:btih:abc'])(
    'presents only after an explicit task is accepted: %s',
    async (url) => {
      const f = fixture()
      await f.run(normalizeTarget({ url, origin: 'context-menu' }))
      expect(
        f.deps.popup.captureSubmission.mock.invocationCallOrder[0]
      ).toBeLessThan(f.deps.ready.mock.invocationCallOrder[0]!)
      expect(f.present).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'right-click-task',
          operationId: expect.any(String),
        }),
        f.guard
      )
      expect(
        f.deps.manager.submitDownload.mock.invocationCallOrder[0]
      ).toBeLessThan(f.present.mock.invocationCallOrder[0]!)
    }
  )

  it.each([
    new DownloadOutcomeUnknownError(),
    new DownloadPreparationError(DOWNLOAD_ERROR.rejected),
  ])('does not present an unaccepted task: %s', async (error) => {
    const f = fixture()
    f.deps.manager.submitDownload.mockRejectedValue(error)
    await f.run(
      normalizeTarget({
        url: 'https://example.com/file.zip',
        origin: 'context-menu',
      })
    )
    expect(f.present).not.toHaveBeenCalled()
  })

  it('does not turn a popup failure into a browser fallback', async () => {
    const f = fixture()
    f.present.mockRejectedValue(new Error('popup unavailable'))
    await expect(
      f.run(
        normalizeTarget({
          url: 'https://example.com/file.zip',
          origin: 'context-menu',
        })
      )
    ).resolves.toBeUndefined()
    expect(extensionBrowser.downloads.download).not.toHaveBeenCalled()
  })
})

describe('confirmation before the first request', () => {
  function confirmedFixture(open = async () => {}) {
    const f = fixture()
    f.deps.getConfig.mockResolvedValue({
      ...TAKEOVER_DEFAULT,
      downloadMode: 'confirm',
    })
    const confirmation = new DownloadConfirmationService({
      supported: () => true,
      open,
      publish: () => {},
      userAgent: () => 'Browser UA',
    })
    const submissions = new DownloadSubmissionService({
      manager: f.deps.manager,
      captureGuard: f.deps.captureGuard,
      isPaired: f.deps.isPaired,
    } as never)
    const run = createContextMenuDownloadRunner({
      ...f.deps,
      confirmation,
      submissions,
    } as never)
    const target = normalizeTarget({
      url: 'https://example.com/one-use.zip',
      origin: 'context-menu',
    })
    return { ...f, confirmation, submissions, run, target }
  }
  it('signals an error and preserves the draft when popup opening fails, without submitting', async () => {
    const f = confirmedFixture(async () => {
      throw new Error('popup unavailable')
    })
    await f.run(f.target, 4)
    expect(f.deps.notify).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'error' })
    )
    expect(f.confirmation.get(4)?.phase).toBe('editing')
    expect(f.deps.manager.submitDownload).not.toHaveBeenCalled()
    expect(extensionBrowser.downloads.download).not.toHaveBeenCalled()
    f.confirmation.close(4)
  })
  it('does not capture credentials or submit before confirmation and forwards edits once', async () => {
    const f = confirmedFixture()
    const running = f.run(f.target, 4)
    await vi.waitFor(() => expect(f.confirmation.get(4)).not.toBeNull())
    expect(f.deps.manager.submitDownload).not.toHaveBeenCalled()
    expect(f.deps.manager.ensureReady).not.toHaveBeenCalled()
    expect(extensionBrowser.cookies.getAll).not.toHaveBeenCalled()
    const draft = f.confirmation.get(4)!
    const options = {
      ...draft.options,
      filename: 'chosen.zip',
      referer: 'https://example.com/page',
    }
    f.confirmation.decide(4, draft.id, { action: 'submit', options })
    await running
    expect(f.deps.manager.submitDownload).toHaveBeenCalledOnce()
    expect(f.deps.manager.submitDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ suggestedFilename: 'chosen.zip' }),
        selection: expect.objectContaining({
          primary: expect.objectContaining({
            headers: {
              'User-Agent': 'Browser UA',
              Referer: 'https://example.com/page',
            },
          }),
        }),
      }),
      expect.anything()
    )
    expect(await f.submissions.list('nas')).toEqual([
      expect.objectContaining({
        state: 'accepted',
        taskId: 'right-click-task',
      }),
    ])
    expect(extensionBrowser.downloads.download).not.toHaveBeenCalled()
  })
  it.each(['cancel', 'browser'])(
    'honors %s without sending to Motrix',
    async (action) => {
      const f = confirmedFixture()
      const running = f.run(f.target, 4)
      await vi.waitFor(() => expect(f.confirmation.get(4)).not.toBeNull())
      f.confirmation.decide(4, f.confirmation.get(4)!.id, { action })
      await running
      expect(f.deps.manager.submitDownload).not.toHaveBeenCalled()
      expect(extensionBrowser.cookies.getAll).not.toHaveBeenCalled()
      expect(extensionBrowser.downloads.download).toHaveBeenCalledTimes(
        action === 'browser' ? 1 : 0
      )
    }
  )
  it.each(['prepare', 'submit', 'unknown'])(
    'never starts a browser request after a confirmed %s failure',
    async (stage) => {
      const f = confirmedFixture()
      if (stage === 'prepare')
        f.deps.manager.ensureReady.mockRejectedValue(
          new DownloadPreparationError(DOWNLOAD_ERROR.connectionFailed)
        )
      else
        f.deps.manager.submitDownload.mockRejectedValue(
          stage === 'unknown'
            ? new DownloadOutcomeUnknownError()
            : new DownloadPreparationError(DOWNLOAD_ERROR.rejected)
        )
      const running = f.run(f.target, 4)
      await vi.waitFor(() => expect(f.confirmation.get(4)).not.toBeNull())
      const draft = f.confirmation.get(4)!
      const options = {
        ...draft.options,
        filename: 'chosen.zip',
        authorization: 'Bearer test',
        useBrowserCookies: false,
      }
      f.confirmation.decide(4, draft.id, { action: 'submit', options })
      await vi.waitFor(() =>
        expect(f.confirmation.get(4)?.phase).toBe(
          stage === 'unknown' ? 'unknown' : 'failed'
        )
      )
      expect(f.confirmation.get(4)?.options).toEqual(options)
      expect(extensionBrowser.downloads.download).not.toHaveBeenCalled()
      expect(extensionBrowser.cookies.getAll).not.toHaveBeenCalled()
      expect(await f.submissions.list('nas')).toEqual([
        expect.objectContaining({
          state: stage === 'unknown' ? 'unknown' : 'failed',
        }),
      ])
      f.confirmation.close(4)
      await running
    }
  )
  it.each(['submit', 'browser', 'cancel'])(
    'uses the shared form for intercepted downloads and preserves the native response on %s',
    async (action) => {
      const f = confirmedFixture()
      const target = { ...f.target, origin: 'auto' as const }
      const run = requestConfirmedDownload(
        {
          ...f.deps,
          confirmation: f.confirmation,
          submissions: f.submissions,
        } as never,
        target,
        4,
        f.guard
      )
      await vi.waitFor(() =>
        expect(f.confirmation.get(4)?.target.origin).toBe('auto')
      )
      expect(f.deps.manager.ensureReady).not.toHaveBeenCalled()
      const draft = f.confirmation.get(4)!
      f.confirmation.decide(4, draft.id, { action, options: draft.options })
      await run
      expect(f.deps.manager.submitDownload).toHaveBeenCalledTimes(
        action === 'submit' ? 1 : 0
      )
      expect(extensionBrowser.downloads.download).not.toHaveBeenCalled()
    }
  )

  it.each(['submit', 'browser', 'cancel'])(
    'replays a cancelled native response only for explicit browser choice: %s',
    async (action) => {
      const f = confirmedFixture()
      const target = {
        ...f.target,
        origin: 'auto' as const,
        nativeDownloadCancelled: true,
      }
      const run = requestConfirmedDownload(
        {
          ...f.deps,
          confirmation: f.confirmation,
          submissions: f.submissions,
        } as never,
        target,
        4,
        f.guard
      )
      await vi.waitFor(() => expect(f.confirmation.get(4)).not.toBeNull())
      const draft = f.confirmation.get(4)!
      f.confirmation.decide(4, draft.id, { action, options: draft.options })
      await run
      expect(f.deps.manager.submitDownload).toHaveBeenCalledTimes(
        action === 'submit' ? 1 : 0
      )
      expect(extensionBrowser.downloads.download).toHaveBeenCalledTimes(
        action === 'browser' ? 1 : 0
      )
    }
  )

  it('does not open confirmation after an endpoint changed during setup', async () => {
    const f = confirmedFixture()
    f.guard.assertCurrent.mockImplementation(() => {
      throw new Error('changed')
    })
    await expect(f.run(f.target, 4)).rejects.toThrow('changed')
    expect(f.confirmation.get(4)).toBeNull()
    expect(f.deps.manager.submitDownload).not.toHaveBeenCalled()
  })
})
