import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/shared/i18n'
import { App } from '@/options/App'
import { i18n } from '@/shared/i18n'
import { LINKS } from '@/shared/links'

afterEach(() => vi.unstubAllGlobals())

// jsdom doesn't include ResizeObserver; the headless Switch thumb needs it.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

declare const browser: {
  runtime: {
    id: string
    getManifest: () => { version: string }
    sendMessage: (env: { kind: string; payload: unknown }) => Promise<unknown>
  }
}

beforeEach(() => {
  window.history.replaceState(null, '', '/options.html')
  browser.runtime.id = 'x'
  browser.runtime.getManifest = vi.fn(() => ({ version: '1.0.0' }))
  browser.runtime.sendMessage = vi.fn(async (env) => {
    if (env.kind === 'bg.getTakeoverConfig')
      return {
        openTaskPanelAfterSubmit: false,
        enabled: false,
        consentAckVersion: 0,
        defaultAction: 'motrix',
        rules: [],
      }
    if (env.kind === 'bg.getEndpointConfig')
      return {
        version: 3,
        activeEndpointId: 'local',
        servers: [],
        cleanupTombstones: [],
      }
    if (env.kind === 'bg.hasPairedBackend') return { paired: false }
    if (env.kind === 'bg.getPairingStatus') return { paired: false }
    if (env.kind === 'bg.getState') return { state: 'disconnected' }
    if (env.kind === 'bg.listAdapters') return { adapters: [] }
    if (env.kind === 'bg.getNotificationsConfig')
      return { master: true, confirm: false, error: true, reminder: true }
    return undefined
  })
})

describe('options App', () => {
  it('hides unavailable backend modules in a temporary Safari extension', async () => {
    vi.stubGlobal('__BROWSER__', 'safari')
    render(<App />)
    expect(
      await screen.findByRole('combobox', { name: /theme|主题/i })
    ).toBeTruthy()
    expect(screen.queryByRole('tab', { name: /downloads|下载/i })).toBeNull()
    expect(screen.queryByRole('tab', { name: /integration|集成/i })).toBeNull()
    expect(
      screen.queryByRole('switch', { name: /open task panel|展开任务面板/i })
    ).toBeNull()
    expect(
      screen.queryByRole('switch', { name: /system notifications|系统通知/i })
    ).toBeNull()
    expect(
      screen.queryByText(/Safari offline preview|Safari 离线预览/i)
    ).toBeNull()
  })
  it('groups appearance, task panel and notifications in General and takeover in Downloads', async () => {
    const user = userEvent.setup()
    render(<App />)
    for (const name of [
      /general|通用/i,
      /downloads|下载/i,
      /integration|集成/i,
      /help|帮助/i,
    ]) {
      expect(screen.getByRole('tab', { name })).toBeTruthy()
    }
    expect(screen.queryByRole('tab', { name: /about|关于/i })).toBeNull()
    expect(screen.queryByRole('tab', { name: /appearance|外观/i })).toBeNull()
    expect(screen.getByRole('combobox', { name: /theme|主题/i })).toBeTruthy()
    expect(
      screen.getByRole('combobox', { name: /language|语言/i })
    ).toBeTruthy()
    expect(
      screen.getByRole('switch', { name: /system notifications|启用系统通知/i })
    ).toBeTruthy()
    expect(
      screen.getByRole('switch', {
        name: /open task panel after adding a download|添加下载后展开任务面板/i,
      })
    ).toBeTruthy()
    expect(screen.queryByRole('spinbutton')).toBeNull()

    await user.click(screen.getByRole('tab', { name: /downloads|下载/i }))
    expect(await screen.findByRole('spinbutton')).toBeTruthy()
    expect(
      screen.getByRole('switch', { name: /send eligible downloads|启用接管/i })
    ).toBeTruthy()
    await waitFor(() => {
      expect(
        screen.queryByRole('switch', {
          name: /open task panel after adding a download|添加下载后展开任务面板/i,
        })
      ).toBeNull()
      expect(screen.queryByRole('combobox', { name: /theme|主题/i })).toBeNull()
      expect(
        screen.queryByRole('combobox', { name: /language|语言/i })
      ).toBeNull()
      expect(
        screen.getByRole('combobox', {
          name: /when file size is unknown|文件大小未知时/i,
        })
      ).toBeTruthy()
    })
    expect(
      screen.getByRole('switch', { name: /ask before downloading|下载前询问/i })
    ).toBeTruthy()
    expect(
      screen.queryByRole('switch', {
        name: /system notifications|启用系统通知/i,
      })
    ).toBeNull()
  })

  it('keeps the website and GitHub links in the page header', () => {
    render(<App />)
    expect(
      screen
        .getByRole('link', { name: /official website|官方网站/i })
        .getAttribute('href')
    ).toBe(LINKS.website)
    expect(
      screen.getByRole('link', { name: 'GitHub' }).getAttribute('href')
    ).toBe(LINKS.repo)
  })
})

it('requires pairing in Downloads and opens the Server editor from the prompt', async () => {
  const user = userEvent.setup()
  render(<App />)
  await user.click(screen.getByRole('tab', { name: /downloads|下载/i }))
  const toggle = await screen.findByRole('switch', {
    name: i18n.t('options.takeover.enableLabel'),
  })
  await waitFor(() => expect(toggle.hasAttribute('disabled')).toBe(false))
  await user.click(toggle)
  expect(
    await screen.findByRole('alertdialog', {
      name: i18n.t('options.takeover.pairingRequiredTitle'),
    })
  ).toBeTruthy()
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  await user.click(
    screen.getByRole('button', {
      name: i18n.t('options.common.cancel'),
      exact: true,
    })
  )
  await user.click(toggle)
  await user.click(
    await screen.findByRole('button', {
      name: i18n.t('options.takeover.addServerPair'),
    })
  )
  expect(
    await screen.findByRole('dialog', {
      name: i18n.t('options.servers.addTitle'),
    })
  ).toBeTruthy()
  expect(window.location.hash).toBe('#integration')
  expect(
    vi
      .mocked(browser.runtime.sendMessage)
      .mock.calls.some(([env]) => env.kind === 'bg.setTakeoverConfig')
  ).toBe(false)
})
