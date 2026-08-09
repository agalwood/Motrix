import '@testing-library/jest-dom/vitest'
import { transport } from '@renderer/lib/transport'
import { DEFAULT_LOCALE } from '@shared/constants/locales'
import { Queries } from '@shared/protocol/queries'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bootstrapRendererLocale } from './bootstrap-locale'
import { i18n } from './i18n'

const mocks = vi.hoisted(() => ({
  platform: 'darwin' as NodeJS.Platform | 'web',
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    get platform() {
      return mocks.platform
    },
  },
}))

describe('bootstrapRendererLocale', () => {
  beforeEach(() => {
    mocks.platform = 'darwin'
    vi.mocked(transport.invoke).mockReset()
  })

  it('prefers an injected URL locale without invoking IPC', async () => {
    await expect(
      bootstrapRendererLocale('main', '?locale=zh-CN')
    ).resolves.toBe('zh-CN')

    expect(transport.invoke).not.toHaveBeenCalled()
    expect(document.documentElement).toHaveAttribute('lang', 'zh-CN')
  })

  it('falls through to persisted settings for an invalid Electron URL locale', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({
      app: { language: 'zh-CN' },
    })

    await expect(
      bootstrapRendererLocale('main', '?locale=invalid')
    ).resolves.toBe('zh-CN')

    expect(transport.invoke).toHaveBeenCalledWith(Queries.GetSettings)
  })

  it('does not trust a URL locale in the web renderer', async () => {
    mocks.platform = 'web'
    vi.mocked(transport.invoke).mockResolvedValue({
      app: { language: 'en-US' },
    })

    await expect(
      bootstrapRendererLocale('main', '?locale=zh-CN')
    ).resolves.toBe('en-US')

    expect(transport.invoke).toHaveBeenCalledWith(Queries.GetSettings)
  })

  it('hydrates onboarding from disclaimer state before rendering', async () => {
    vi.mocked(transport.invoke).mockResolvedValue({ language: 'zh-CN' })

    await expect(bootstrapRendererLocale('onboarding')).resolves.toBe('zh-CN')

    expect(transport.invoke).toHaveBeenCalledWith(Queries.GetDisclaimerState)
    expect(i18n.resolvedLanguage).toBe('zh-CN')
    expect(document.documentElement).toHaveAttribute('lang', 'zh-CN')
  })

  it.each(['main', 'add-task'] as const)(
    'hydrates the %s window from persisted settings',
    async (windowId) => {
      vi.mocked(transport.invoke).mockResolvedValue({
        app: { language: 'zh-CN' },
      })

      await expect(bootstrapRendererLocale(windowId)).resolves.toBe('zh-CN')

      expect(transport.invoke).toHaveBeenCalledWith(Queries.GetSettings)
    }
  )

  it('uses the default locale when hydration fails', async () => {
    vi.mocked(transport.invoke).mockRejectedValue(new Error('unavailable'))

    await expect(bootstrapRendererLocale('main')).resolves.toBe(DEFAULT_LOCALE)
    expect(i18n.resolvedLanguage).toBe(DEFAULT_LOCALE)
  })
})
