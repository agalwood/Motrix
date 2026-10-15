import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/shared/i18n'
import { GeneralTab } from '@/options/tabs/GeneralTab'
import { i18n } from '@/shared/i18n'
import { getLocaleOverride } from '@/shared/localeStore'
import { LOCALE_NAMES, SUPPORTED_LOCALES } from '@/shared/supportedLocales'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'
import { getThemeOverride } from '@/shared/themeStore'

declare const browser: {
  runtime: {
    sendMessage: (env: { kind: string; payload: unknown }) => Promise<unknown>
  }
  storage: {
    local: {
      get: (k: string) => Promise<Record<string, unknown>>
      set: (i: Record<string, unknown>) => Promise<void>
      remove: (k: string) => Promise<void>
    }
  }
}

beforeEach(() => {
  browser.runtime.sendMessage = vi.fn(async (env) => {
    if (env.kind === 'bg.getTakeoverConfig') return TAKEOVER_DEFAULT
    if (env.kind === 'bg.getNotificationsConfig')
      return { master: true, confirm: false, error: true, reminder: true }
    if (env.kind === 'bg.setNotificationsConfig') return { ok: true }
    throw new Error(`unexpected ${env.kind}`)
  })
  let bag: Record<string, unknown> = {}
  browser.storage.local.get = vi.fn(async (k: string) =>
    k in bag ? { [k]: bag[k] } : {}
  )
  browser.storage.local.set = vi.fn(async (i: Record<string, unknown>) => {
    bag = { ...bag, ...i }
  })
  browser.storage.local.remove = vi.fn(async (k: string) => {
    delete bag[k]
  })
})

afterEach(async () => {
  await i18n.changeLanguage('en-US')
})

describe('GeneralTab appearance settings', () => {
  it('offers every language and applies Traditional Chinese', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<GeneralTab />)
    await user.click(await screen.findByRole('combobox', { name: /language/i }))
    for (const locale of SUPPORTED_LOCALES) {
      expect(
        await screen.findByRole('option', { name: LOCALE_NAMES[locale] })
      ).toBeTruthy()
    }
    await user.click(screen.getByRole('option', { name: '繁體中文' }))
    await user.click(screen.getByRole('button', { name: /apply/i }))
    await waitFor(async () => {
      expect(await getLocaleOverride()).toBe('zh-TW')
      expect(i18n.language).toBe('zh-TW')
      expect(screen.getByRole('combobox', { name: '語言' })).toBeTruthy()
    })
  })

  it('Apply persists theme + language and applies language live', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<GeneralTab />)

    await user.click(await screen.findByRole('combobox', { name: /theme/i }))
    await user.click(await screen.findByRole('option', { name: /dark/i }))
    expect(
      screen.getByRole('combobox', { name: /theme/i }).textContent
    ).toContain('Dark')

    await user.click(screen.getByRole('combobox', { name: /language/i }))
    await user.click(await screen.findByRole('option', { name: '简体中文' }))
    expect(
      screen.getByRole('combobox', { name: /language/i }).textContent
    ).toContain('简体中文')

    await user.click(screen.getByRole('button', { name: /apply/i }))

    await waitFor(async () => {
      expect(await getThemeOverride()).toBe('dark')
      expect(await getLocaleOverride()).toBe('zh-CN')
      expect(i18n.language).toBe('zh-CN')
    })
  })
})
