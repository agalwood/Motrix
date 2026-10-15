import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@/shared/i18n'
import { GeneralTab } from '@/options/tabs/GeneralTab'
import type { NotificationsConfig } from '@/shared/notifications'
import { TAKEOVER_DEFAULT } from '@/shared/takeover'

vi.mock('@/shared/platformCapabilities', () => ({
  supportsAutoOpenPopup: () => true,
  supportsSystemNotifications: () => true,
  supportsDownloadTakeover: () => true,
}))

declare const browser: {
  runtime: {
    sendMessage: (env: { kind: string; payload: unknown }) => Promise<unknown>
  }
}

let savedNotify: NotificationsConfig | null

function mockBg(notif: NotificationsConfig): void {
  savedNotify = null
  browser.runtime.sendMessage = vi.fn(async (env) => {
    if (env.kind === 'bg.getTakeoverConfig') return TAKEOVER_DEFAULT
    if (env.kind === 'bg.getNotificationsConfig') return notif
    if (env.kind === 'bg.patchTaskPanelPreference')
      return { ...TAKEOVER_DEFAULT, ...(env.payload as object) }
    if (env.kind === 'bg.setNotificationsConfig') {
      savedNotify = env.payload as NotificationsConfig
      return { ok: true }
    }
    throw new Error(`unexpected ${env.kind}`)
  })
}

beforeEach(() => {
  mockBg({ master: true, confirm: false, error: true, reminder: true })
})

describe('GeneralTab', () => {
  it('loads and saves task panel opening through the same preference used by Popup', async () => {
    render(<GeneralTab />)
    await waitFor(() =>
      expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
        kind: 'bg.getTakeoverConfig',
        payload: undefined,
      })
    )
    const control = await screen.findByRole('switch', {
      name: /open task panel after adding a download/i,
    })
    expect(control.hasAttribute('data-disabled')).toBe(false)
    fireEvent.click(control)
    fireEvent.click(screen.getByRole('button', { name: /apply/i }))
    await waitFor(() =>
      expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
        kind: 'bg.patchTaskPanelPreference',
        payload: { openTaskPanelAfterSubmit: true },
      })
    )
    expect(browser.runtime.sendMessage).not.toHaveBeenCalledWith({
      kind: 'bg.setTakeoverConfig',
      payload: expect.anything(),
    })
  })
  it('hides the three detail switches when master is off', async () => {
    mockBg({ master: false, confirm: false, error: true, reminder: true })
    render(<GeneralTab />)
    // master switch is always present
    await screen.findByRole('switch', {
      name: /system notifications|启用系统通知/i,
    })
    // after load (master=false) the detail switches are not rendered
    await waitFor(() => {
      expect(
        screen.queryByRole('switch', {
          name: /success|confirmation|成功|确认/i,
        })
      ).toBeNull()
      expect(
        screen.queryByRole('switch', { name: /failure|error|失败|错误/i })
      ).toBeNull()
      expect(
        screen.queryByRole('switch', { name: /reminder|提醒/i })
      ).toBeNull()
    })
  })

  it('flipping a detail switch then Apply persists the notifications config', async () => {
    render(<GeneralTab />)
    const confirm = await screen.findByRole('switch', {
      name: /success|confirmation|成功|确认/i,
    })
    fireEvent.click(confirm)
    fireEvent.click(screen.getByRole('button', { name: /apply|应用/i }))
    await waitFor(() => {
      expect(browser.runtime.sendMessage).not.toHaveBeenCalledWith({
        kind: 'bg.setTakeoverConfig',
        payload: expect.anything(),
      })
      expect(savedNotify).toEqual({
        master: true,
        confirm: true,
        error: true,
        reminder: true,
      })
      expect(browser.runtime.sendMessage).not.toHaveBeenCalledWith({
        kind: 'bg.patchTaskPanelPreference',
        payload: expect.anything(),
      })
    })
  })

  it('shows an error instead of saved when the background rejects a setting', async () => {
    browser.runtime.sendMessage = vi.fn(async (env) => {
      if (env.kind === 'bg.getTakeoverConfig') return TAKEOVER_DEFAULT
      if (env.kind === 'bg.getNotificationsConfig') {
        return { master: true, confirm: false, error: true, reminder: true }
      }
      if (env.kind === 'bg.setNotificationsConfig') {
        return { error: 'storage unavailable' }
      }
      return { ok: true }
    })
    render(<GeneralTab />)
    const master = await screen.findByRole('switch', {
      name: /system notifications|启用系统通知/i,
    })
    fireEvent.click(master)
    fireEvent.click(screen.getByRole('button', { name: /apply|应用/i }))

    expect(await screen.findByText('storage unavailable')).toBeTruthy()
    expect(screen.queryByText(/^saved$|^已保存$/i)).toBeNull()
  })

  it('contains a background startup failure instead of leaking an unhandled load rejection', async () => {
    browser.runtime.sendMessage = vi.fn(async () => ({
      error: 'background startup unavailable',
    }))

    render(<GeneralTab />)

    expect(
      (
        await screen.findByText(/settings could not be loaded|设置加载失败/i)
      ).getAttribute('role')
    ).toBe('alert')
    expect(
      screen.queryByRole('switch', {
        name: /system notifications|启用系统通知/i,
      })
    ).toBeNull()
  })
})
