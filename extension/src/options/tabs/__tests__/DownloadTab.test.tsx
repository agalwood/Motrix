import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/shared/i18n'
import { ENDPOINT_CONFIG_STORAGE_KEY } from '@/background/EndpointConfigStore'
import { DownloadTab } from '@/options/tabs/DownloadTab'
import type { TakeoverConfig } from '@/shared/takeover'

declare const browser: {
  storage: {
    onChanged: {
      addListener: (
        listener: (changes: Record<string, unknown>, area: string) => void
      ) => void
      removeListener: (listener: unknown) => void
    }
  }
  runtime: {
    sendMessage: (env: { kind: string; payload: unknown }) => Promise<unknown>
  }
}

let savedTakeover: TakeoverConfig | null
let pairedBackend: boolean

beforeEach(() => {
  savedTakeover = null
  pairedBackend = true
  browser.runtime.sendMessage = vi.fn(async (env) => {
    if (env.kind === 'bg.hasPairedBackend') return { paired: pairedBackend }
    if (env.kind === 'bg.getEndpointConfig')
      return { activeEndpointId: 'local' }
    if (env.kind === 'bg.getTakeoverConfig') {
      if (savedTakeover) return savedTakeover
      return {
        enabled: false,
        consentAckVersion: 0,
        defaultAction: 'motrix',
        rules: [],
      } satisfies TakeoverConfig
    }
    if (env.kind === 'bg.setTakeoverConfig') {
      savedTakeover = env.payload as TakeoverConfig
      return undefined
    }
    throw new Error(`unexpected ${env.kind}`)
  })
})

describe('DownloadTab', () => {
  it('saves and reloads the user choice for downloads of unknown size', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 })
    const first = render(<DownloadTab />)
    const control = await screen.findByRole('combobox', {
      name: /when file size is unknown/i,
    })
    expect(control.textContent).toContain('Download with browser')
    await user.click(control)
    await user.click(
      await screen.findByRole('option', { name: 'Download with Motrix' })
    )
    await user.click(screen.getByRole('button', { name: /apply/i }))
    await waitFor(() => expect(savedTakeover?.unknownSizeAction).toBe('motrix'))
    first.unmount()

    render(<DownloadTab />)
    await waitFor(() =>
      expect(
        screen.getByRole('combobox', { name: /when file size is unknown/i })
          .textContent
      ).toContain('Download with Motrix')
    )
    await user.click(
      screen.getByRole('combobox', { name: /when file size is unknown/i })
    )
    await user.click(
      await screen.findByRole('option', { name: 'Download with browser' })
    )
    await user.click(screen.getByRole('button', { name: /apply/i }))
    await waitFor(() => expect(savedTakeover?.unknownSizeAction).toBe('chrome'))
  })

  it('gates first enable on consent, then Apply persists the takeover config', async () => {
    const user = userEvent.setup()
    render(<DownloadTab />)
    await screen.findByRole('switch', {
      name: /send eligible downloads|将符合条件的下载发送到 Motrix/i,
    })
    await user.click(
      screen.getByRole('switch', {
        name: /send eligible downloads|将符合条件的下载发送到 Motrix/i,
      })
    )
    await user.click(
      await screen.findByRole('button', { name: /enable|开启|understand/i })
    )
    await user.click(await screen.findByRole('button', { name: /apply|应用/i }))
    await waitFor(() => {
      expect(savedTakeover).not.toHaveProperty('openTaskPanelAfterSubmit')
      expect(savedTakeover?.enabled).toBe(true)
      expect(savedTakeover?.consentAckVersion).toBe(1)
      expect(browser.runtime.sendMessage).not.toHaveBeenCalledWith({
        kind: 'bg.setNotificationsConfig',
        payload: expect.anything(),
      })
    })
  })

  it('requires pairing before consent and permits enabling after pairing completes', async () => {
    pairedBackend = false
    const user = userEvent.setup()
    render(<DownloadTab />)
    const toggle = await screen.findByRole('switch', {
      name: /send eligible downloads/i,
    })
    await user.click(toggle)
    expect(
      await screen.findByRole('heading', { name: 'Pair a backend first' })
    ).toBeTruthy()
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(savedTakeover).toBeNull()
    await user.click(
      screen.getByRole('button', { name: 'Cancel', exact: true })
    )
    pairedBackend = true
    await user.click(toggle)
    await user.click(
      await screen.findByRole('button', { name: /enable|understand/i })
    )
    await user.click(screen.getByRole('button', { name: /apply/i }))
    await waitFor(() => expect(savedTakeover?.enabled).toBe(true))
  })

  it('disables remote takeover, retains the local preference on Apply, and reacts to selection changes', async () => {
    let activeEndpointId = 'nas'
    const originalSend = browser.runtime.sendMessage
    browser.runtime.sendMessage = vi.fn(async (env) => {
      if (env.kind === 'bg.getEndpointConfig') return { activeEndpointId }
      if (env.kind === 'bg.getTakeoverConfig')
        return {
          enabled: true,
          consentAckVersion: 1,
          defaultAction: 'motrix',
          rules: [],
        }
      return originalSend(env)
    })
    const { unmount } = render(<DownloadTab />)
    const control = await screen.findByRole('switch', {
      name: /send eligible downloads/i,
    })
    await screen.findByText(
      /Automatic takeover currently requires the local Motrix App/
    )
    expect(control.hasAttribute('data-disabled')).toBe(true)
    expect(control.getAttribute('aria-checked')).toBe('false')
    fireEvent.change(screen.getByRole('spinbutton'), {
      target: { value: '10' },
    })
    fireEvent.click(screen.getByRole('button', { name: /apply/i }))
    await waitFor(() => expect(savedTakeover?.enabled).toBe(true))
    const changed = vi
      .mocked(browser.storage.onChanged.addListener)
      .mock.calls.at(-1)![0]
    activeEndpointId = 'local'
    act(() => changed({ [ENDPOINT_CONFIG_STORAGE_KEY]: {} }, 'local'))
    await waitFor(() =>
      expect(control.hasAttribute('data-disabled')).toBe(false)
    )
    expect(control.getAttribute('aria-checked')).toBe('true')
    activeEndpointId = 'nas'
    act(() => changed({ [ENDPOINT_CONFIG_STORAGE_KEY]: {} }, 'local'))
    await waitFor(() =>
      expect(control.hasAttribute('data-disabled')).toBe(true)
    )
    expect(control.getAttribute('aria-checked')).toBe('false')
    unmount()
    expect(browser.storage.onChanged.removeListener).toHaveBeenCalledWith(
      changed
    )
  })

  it('shows an error instead of saved when the background rejects a setting', async () => {
    browser.runtime.sendMessage = vi.fn(async (env) => {
      if (env.kind === 'bg.getEndpointConfig')
        return { activeEndpointId: 'local' }
      if (env.kind === 'bg.getTakeoverConfig') {
        return {
          enabled: false,
          consentAckVersion: 0,
          defaultAction: 'motrix',
          rules: [],
        } satisfies TakeoverConfig
      }
      if (env.kind === 'bg.setTakeoverConfig') {
        return { error: 'storage unavailable' }
      }
      return { ok: true }
    })
    render(<DownloadTab />)
    const threshold = await screen.findByRole('spinbutton')
    fireEvent.change(threshold, { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: /apply|应用/i }))

    expect(await screen.findByText('storage unavailable')).toBeTruthy()
    expect(screen.queryByText(/^saved$|^已保存$/i)).toBeNull()
  })

  it('contains a background startup failure instead of leaking an unhandled load rejection', async () => {
    browser.runtime.sendMessage = vi.fn(async () => ({
      error: 'background startup unavailable',
    }))

    render(<DownloadTab />)

    expect(
      (
        await screen.findByText(/settings could not be loaded|设置加载失败/i)
      ).getAttribute('role')
    ).toBe('alert')
    expect(
      screen.queryByRole('switch', {
        name: /send eligible downloads|将符合条件的下载发送到 Motrix/i,
      })
    ).toBeNull()
  })
})
