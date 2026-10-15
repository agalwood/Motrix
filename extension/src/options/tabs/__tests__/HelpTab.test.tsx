import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/shared/i18n'
import { HelpTab } from '@/options/tabs/HelpTab'
import { LINKS } from '@/shared/links'
import { getLogLevel } from '@/shared/logLevel'

declare const browser: {
  runtime: {
    id: string
    getManifest: () => { version: string }
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
  browser.runtime.id = 'test-ext-id'
  browser.runtime.getManifest = vi.fn(() => ({ version: '9.9.9' }))
  browser.runtime.sendMessage = vi.fn(async (env) => {
    if (env.kind === 'bg.listAdapters') return { adapters: [] }
    throw new Error(`unexpected ${env.kind}`)
  })
})

describe('HelpTab', () => {
  it('shows support links and diagnostics without an about section', async () => {
    const { container } = render(<HelpTab />)
    expect(await screen.findByText('test-ext-id')).toBeTruthy()
    expect(screen.getByText('9.9.9')).toBeTruthy()
    const links = screen.getAllByRole('link') as HTMLAnchorElement[]
    expect(links).toHaveLength(2)
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      expect.arrayContaining([LINKS.issues, LINKS.docs])
    )
    expect(LINKS.docs).toBe('https://motrix.app/manual/browser-extension/')
    expect(links.every((link) => link.getAttribute('role') === null)).toBe(true)
    expect(container.querySelector('.lucide-external-link')).toBeNull()
    expect(container.querySelectorAll('.lucide-chevron-right')).toHaveLength(2)
    expect(screen.queryByText(/about Motrix|关于 Motrix/i)).toBeNull()
  })

  it('Apply persists the chosen log level', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    render(<HelpTab />)
    await user.click(
      await screen.findByRole('combobox', { name: /log level/i })
    )
    await user.click(await screen.findByRole('option', { name: /debug/i }))
    expect(
      screen.getByRole('combobox', { name: /log level/i }).textContent
    ).toContain('Debug')
    await user.click(screen.getByRole('button', { name: /apply|应用/i }))
    await waitFor(async () => expect(await getLogLevel()).toBe('debug'))
  })
})
