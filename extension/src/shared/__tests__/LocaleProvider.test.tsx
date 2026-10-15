import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSlot,
} from '@/components/ui/input-otp'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { extensionBrowser } from '@/shared/browser'
import { i18n } from '@/shared/i18n'
import { LocaleProvider } from '@/shared/LocaleProvider'

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
})

afterEach(() => {
  document.documentElement.removeAttribute('dir')
  document.documentElement.removeAttribute('lang')
})

describe('extension page locale', () => {
  it.each(['ar', 'fa'])(
    'applies %s direction and restores LTR when switching',
    async (locale) => {
      await i18n.changeLanguage(locale)
      render(
        <LocaleProvider>
          <span>Motrix</span>
        </LocaleProvider>
      )
      expect(document.documentElement.lang).toBe(locale)
      expect(document.documentElement.dir).toBe('rtl')
      await act(() => i18n.changeLanguage('en-US'))
      expect(document.documentElement.lang).toBe('en-US')
      expect(document.documentElement.dir).toBe('ltr')
    }
  )

  it('syncs changes from another extension page and removes its listener', async () => {
    const { unmount } = render(
      <LocaleProvider>
        <span>Motrix</span>
      </LocaleProvider>
    )
    const listener = vi
      .mocked(extensionBrowser.storage.onChanged.addListener)
      .mock.calls.at(-1)![0]
    vi.mocked(extensionBrowser.storage.local.get).mockResolvedValue({
      'motrix.locale': 'fa',
    })
    act(() => listener({ 'motrix.locale': { newValue: 'fa' } }, 'sync'))
    expect(document.documentElement.dir).toBe('ltr')
    act(() => listener({ 'motrix.locale': { newValue: 'fa' } }, 'local'))
    await waitFor(() => expect(document.documentElement.lang).toBe('fa'))
    expect(document.documentElement.dir).toBe('rtl')
    unmount()
    expect(
      extensionBrowser.storage.onChanged.removeListener
    ).toHaveBeenCalledWith(listener)
  })

  it('uses RTL arrow-key navigation for Base UI tabs', async () => {
    await i18n.changeLanguage('ar')
    const user = userEvent.setup()
    render(
      <LocaleProvider>
        <Tabs defaultValue="first">
          <TabsList>
            <TabsTrigger value="first">First</TabsTrigger>
            <TabsTrigger value="second">Second</TabsTrigger>
            <TabsTrigger value="third">Third</TabsTrigger>
          </TabsList>
        </Tabs>
      </LocaleProvider>
    )
    await user.click(screen.getByRole('tab', { name: 'First' }))
    await user.keyboard('{ArrowLeft}')
    expect(document.activeElement).toBe(
      screen.getByRole('tab', { name: 'Second' })
    )
    await user.keyboard('{ArrowRight}')
    expect(document.activeElement).toBe(
      screen.getByRole('tab', { name: 'First' })
    )
  })

  it('keeps pairing codes in logical input order in RTL pages', async () => {
    await i18n.changeLanguage('fa')
    const user = userEvent.setup()
    render(
      <LocaleProvider>
        <InputOTP maxLength={4} aria-label="Pairing code">
          <InputOTPGroup>
            {[0, 1, 2, 3].map((index) => (
              <InputOTPSlot key={index} index={index} />
            ))}
          </InputOTPGroup>
        </InputOTP>
      </LocaleProvider>
    )
    const input = screen.getByRole('textbox') as HTMLInputElement
    await user.type(input, 'AB12')
    expect(input.value).toBe('AB12')
    expect(input.dir).toBe('ltr')
    expect(
      [...document.querySelectorAll('[data-slot="input-otp-slot"]')]
        .map((slot) => slot.textContent)
        .join('')
    ).toBe('AB12')
  })
})
