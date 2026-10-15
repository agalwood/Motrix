import {
  type DownloadSubmitParams,
  DownloadSubmitParamsSchema,
} from '@motrix/mdxp'
import { describe, expect, it, vi } from 'vitest'
import {
  buildManualTaskSubmitParams,
  createManualTaskHandler,
  isExtensionPageSender,
  MANUAL_TASK_ERROR,
} from '@/background/manualTask'
import { parseManualTaskInput } from '@/shared/manualTask'

const extensionId = 'test-extension-id'
const extensionBaseUrl = `chrome-extension://${extensionId}/`
const popupSender = {
  id: extensionId,
  url: `${extensionBaseUrl}popup.html`,
}

describe('manual task background adapter', () => {
  it('allows an extension page but rejects a content-script sender', () => {
    expect(
      isExtensionPageSender(popupSender, extensionId, extensionBaseUrl)
    ).toBe(true)
    expect(
      isExtensionPageSender(
        {
          id: extensionId,
          url: 'https://example.com/page',
          tab: { id: 1 },
        },
        extensionId,
        extensionBaseUrl
      )
    ).toBe(false)
    expect(
      isExtensionPageSender(
        { id: 'another-extension', url: `${extensionBaseUrl}popup.html` },
        extensionId,
        extensionBaseUrl
      )
    ).toBe(false)
    expect(
      isExtensionPageSender(
        { id: extensionId, url: 'https://example.com/popup.html' },
        extensionId,
        extensionBaseUrl
      )
    ).toBe(false)
  })

  it('builds direct MDXP params with default-directory semantics and no credentials', () => {
    const parsed = parseManualTaskInput('https://cdn.example.com/file.zip')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(
      buildManualTaskSubmitParams(parsed.value, 'manual-key-123', 1234)
    ).toEqual({
      source: {
        pageUrl: 'https://cdn.example.com/file.zip',
        pageTitle: 'file.zip',
        detectedAt: 1234,
      },
      selection: {
        kind: 'direct',
        primary: {
          url: 'https://cdn.example.com/file.zip',
          headers: {},
          cookies: [],
          refererPolicy: 'strict-origin-when-cross-origin',
        },
      },
      meta: { suggestedFilename: 'file.zip', qualityLabel: 'file' },
      idempotencyKey: 'manual-key-123',
    })
    expect(
      DownloadSubmitParamsSchema.safeParse(
        buildManualTaskSubmitParams(parsed.value, 'manual-key-123', 1234)
      ).success
    ).toBe(true)
  })

  it.each([
    'http://172.16.50.14/My%20File.zip?token=a%2Bb',
    'http://[::1]:8080/file.zip',
    'http://nas/file.zip',
    'https://例子.测试/file.zip',
  ])('builds protocol-valid params for a local or IDN URL: %s', (input) => {
    const parsed = parseManualTaskInput(input)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const params = buildManualTaskSubmitParams(
      parsed.value,
      'manual-key-123',
      0
    )
    expect(DownloadSubmitParamsSchema.parse(params)).toMatchObject({
      selection: { kind: 'direct', primary: { url: new URL(input).href } },
    })
  })

  it('builds a magnet selection without HTTP resource fields', () => {
    const parsed = parseManualTaskInput('magnet:?xt=urn:btih:abcdef&dn=Example')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(
      buildManualTaskSubmitParams(parsed.value, 'manual-key-123', 1234)
        .selection
    ).toEqual({
      kind: 'magnet',
      uri: 'magnet:?xt=urn:btih:abcdef&dn=Example',
    })
  })

  it('forwards the complete params and preserves the caller idempotency key', async () => {
    const submitDownload = vi.fn(async (_params: DownloadSubmitParams) => ({
      taskId: 'task-1',
    }))
    const handler = createManualTaskHandler({
      extensionId,
      extensionBaseUrl,
      now: () => 5678,
      submitDownload,
    })

    await expect(
      handler(
        {
          input: 'https://example.com/file.iso',
          idempotencyKey: 'caller-key-12345678',
        },
        popupSender
      )
    ).resolves.toEqual({ taskId: 'task-1' })
    expect(submitDownload).toHaveBeenCalledOnce()
    expect(submitDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'caller-key-12345678',
        source: expect.objectContaining({ detectedAt: 5678 }),
      }),
      { pairIfNeeded: false }
    )
  })

  it('rejects content scripts before forwarding', async () => {
    const submitDownload = vi.fn()
    const handler = createManualTaskHandler({
      extensionId,
      extensionBaseUrl,
      submitDownload,
    })

    await expect(
      handler(
        {
          input: 'https://example.com/private.zip',
          idempotencyKey: 'caller-key-12345678',
        },
        {
          id: extensionId,
          url: 'https://example.com/page',
          tab: { id: 1 },
        }
      )
    ).rejects.toThrow(MANUAL_TASK_ERROR.forbidden)
    expect(submitDownload).not.toHaveBeenCalled()
  })

  it.each(['short', 'x'.repeat(129)])(
    'rejects an invalid idempotency key length without forwarding',
    async (idempotencyKey) => {
      const submitDownload = vi.fn()
      const handler = createManualTaskHandler({
        extensionId,
        extensionBaseUrl,
        submitDownload,
      })

      await expect(
        handler(
          { input: 'https://example.com/file.zip', idempotencyKey },
          popupSender
        )
      ).rejects.toThrow(MANUAL_TASK_ERROR.invalidRequest)
      expect(submitDownload).not.toHaveBeenCalled()
    }
  )

  it.each(['x'.repeat(8), 'x'.repeat(128)])(
    'accepts an idempotency key at a contract boundary',
    async (idempotencyKey) => {
      const submitDownload = vi.fn(async () => ({ taskId: 'task-1' }))
      const handler = createManualTaskHandler({
        extensionId,
        extensionBaseUrl,
        submitDownload,
      })

      await handler(
        { input: 'https://example.com/file.zip', idempotencyKey },
        popupSender
      )
      expect(submitDownload).toHaveBeenCalledWith(
        expect.objectContaining({ idempotencyKey }),
        { pairIfNeeded: false }
      )
    }
  )

  it('rejects invalid input before forwarding', async () => {
    const submitDownload = vi.fn()
    const handler = createManualTaskHandler({
      extensionId,
      extensionBaseUrl,
      submitDownload,
    })

    await expect(
      handler(
        {
          input: 'file:///Users/me/private',
          idempotencyKey: 'caller-key-12345678',
        },
        popupSender
      )
    ).rejects.toThrow(MANUAL_TASK_ERROR.invalidRequest)
    expect(submitDownload).not.toHaveBeenCalled()
  })

  it('maps submission errors to a safe reason without leaking details', async () => {
    const submitDownload = vi.fn(async () => {
      throw new Error(
        'failed for https://user:secret@example.com/private at /Users/me'
      )
    })
    const handler = createManualTaskHandler({
      extensionId,
      extensionBaseUrl,
      submitDownload,
    })

    await expect(
      handler(
        {
          input: 'https://user:secret@example.com/private',
          idempotencyKey: 'caller-key-12345678',
        },
        popupSender
      )
    ).rejects.toThrow(MANUAL_TASK_ERROR.submitFailed)
  })
})

it('uses the current browser UA for manual downloads and validates edited headers', async () => {
  const submitDownload = vi.fn(async () => ({ taskId: 'ua-task' }))
  const handler = createManualTaskHandler({
    extensionId,
    extensionBaseUrl,
    submitDownload,
  })
  const request = {
    input: 'https://example.com/download',
    idempotencyKey: 'manual-ua-key',
  }
  await handler(request, popupSender)
  expect(submitDownload).toHaveBeenCalledWith(
    expect.objectContaining({
      selection: expect.objectContaining({
        primary: expect.objectContaining({
          headers: { 'User-Agent': navigator.userAgent },
        }),
      }),
    }),
    { pairIfNeeded: false }
  )
  await expect(
    handler(
      {
        ...request,
        options: {
          filename: '',
          userAgent: 'UA\r\nX-Test: injected',
          referer: '',
          cookie: '',
          authorization: '',
          extraHeaders: '',
          useBrowserCookies: false,
        },
      },
      popupSender
    )
  ).rejects.toThrow(MANUAL_TASK_ERROR.invalidRequest)
  expect(submitDownload).toHaveBeenCalledOnce()
})
