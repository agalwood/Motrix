import { describe, expect, it, vi } from 'vitest'
import type { ChromiumInterceptionDeps } from '@/background/interception/chromium'
import { confirmInterceptedDownload } from '@/background/interception/confirmDownload'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'

const item = {
  url: 'https://example.com/request',
  finalUrl: 'https://cdn.example.com/once.zip',
  totalBytes: 1024,
  filename: '/Downloads/once.zip',
  referrer: 'https://example.com/share',
}
function fixture() {
  const guard = { origin: 'auto', assertCurrent: vi.fn() }
  const deps = {
    confirm: vi.fn(async () => {}),
    captureGuard: vi.fn(async () => guard),
  }
  return {
    deps: deps as unknown as ChromiumInterceptionDeps,
    confirm: deps.confirm,
    guard,
    captureGuard: deps.captureGuard,
  }
}
const config = {
  ...TAKEOVER_DEFAULT,
  enabled: true,
  downloadMode: 'confirm' as const,
}
it('confirms the intercepted final URL using only browser metadata and the captured window', async () => {
  const f = fixture()
  await confirmInterceptedDownload(item, config, Promise.resolve(4), f.deps)
  expect(f.confirm).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      url: item.finalUrl,
      origin: 'auto',
      suggestedFilename: 'once.zip',
      sizeBytes: 1024,
      pageUrl: item.referrer,
    }),
    4,
    f.guard
  )
})
describe('confirmation respects automatic takeover policy', () => {
  it.each([
    { ...config, enabled: false },
    { ...config, defaultAction: 'chrome' as const },
    {
      ...config,
      rules: [
        { id: 'small', match: { minSizeMB: 10 }, action: 'chrome' as const },
      ],
    },
    {
      ...config,
      rules: [
        {
          id: 'excluded',
          match: { domains: ['example.com'] },
          action: 'chrome' as const,
        },
      ],
    },
  ])('leaves excluded downloads in the browser', async (cfg) => {
    const f = fixture()
    await confirmInterceptedDownload(item, cfg, Promise.resolve(4), f.deps)
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.captureGuard).not.toHaveBeenCalled()
  })
  it.each(['chrome', 'motrix'] as const)(
    'uses the configured handler for unknown size: %s',
    async (unknownSizeAction) => {
      const f = fixture()
      await confirmInterceptedDownload(
        { ...item, totalBytes: -1 },
        { ...config, unknownSizeAction },
        Promise.resolve(4),
        f.deps
      )
      expect(f.confirm).toHaveBeenCalledTimes(
        unknownSizeAction === 'motrix' ? 1 : 0
      )
    }
  )
  it('does not confirm a remote or changed backend', async () => {
    const f = fixture()
    f.captureGuard.mockResolvedValueOnce(null as never)
    await confirmInterceptedDownload(item, config, Promise.resolve(4), f.deps)
    expect(f.confirm).not.toHaveBeenCalled()
    f.guard.assertCurrent.mockImplementation(() => {
      throw new Error('changed')
    })
    await expect(
      confirmInterceptedDownload(item, config, Promise.resolve(4), f.deps)
    ).rejects.toThrow('changed')
    expect(f.confirm).not.toHaveBeenCalled()
  })
})
