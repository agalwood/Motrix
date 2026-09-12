import '@testing-library/jest-dom/vitest'
import { i18n } from '@renderer/lib/i18n'
import { EXTERNAL_URLS } from '@shared/external-urls'
import { Commands } from '@shared/protocol/commands'
import { NatState, type NatStatus } from '@shared/types/nat'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke, openExternal } = vi.hoisted(() => ({
  invoke: vi.fn(),
  openExternal: vi.fn(),
}))
const natState = vi.hoisted(() => ({ status: null as NatStatus | null }))

vi.mock('@renderer/hooks/use-nat-status', () => ({
  useNatStatus: () => natState.status,
}))

vi.mock('@renderer/lib/transport', () => ({
  transport: {
    invoke,
    on: vi.fn(),
    off: vi.fn(),
    platform: 'darwin',
  },
}))

vi.mock('@renderer/platform/services', () => ({
  usePlatformServices: () => ({ openExternal }),
}))

const { NatBadge } = await import('./nat-badge')

function renderBadge() {
  return render(
    <MemoryRouter>
      <NatBadge />
      <Routes>
        <Route path="/" element={null} />
        <Route
          path="/settings/network"
          element={<h1>Network preferences</h1>}
        />
      </Routes>
    </MemoryRouter>
  )
}

describe('NatBadge', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
    invoke.mockReset().mockResolvedValue({ ok: true })
    openExternal.mockReset()
    natState.status = {
      state: NatState.Failed,
      enabled: true,
      activeMappings: [],
      gatewayInfo: null,
      lastError: null,
      lastDiagnostic: null,
      retryAttempt: 3,
      maxRetries: 3,
    }
  })

  afterEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  it('keeps exhausted mapping attempts neutral and explains their impact on demand', async () => {
    renderBadge()

    const badge = screen.getByRole('button', { name: 'NAT mapping' })
    expect(badge.querySelector('.bg-muted-foreground')).toBeInTheDocument()
    expect(screen.queryByText(/failed/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/mapping unavailable/)).not.toBeInTheDocument()
    fireEvent.click(badge)
    expect(
      await screen.findByText('Automatic mapping unavailable')
    ).toBeVisible()
    expect(screen.getByText(/link downloads/)).toBeVisible()
    expect(screen.getByText('Automatic retries (3/3)')).toBeVisible()
  })

  it.each([
    ['en-US', NatState.Failed, 'NAT mapping', 'Network guide', 'en'],
    ['en-US', NatState.Active, 'NAT mapped', 'Network guide', 'en'],
    ['zh-CN', NatState.Failed, 'NAT 映射', '优化网络', 'zh'],
    ['zh-TW', NatState.Failed, 'NAT 對應', '最佳化網路', 'zh'],
  ] as const)(
    'opens the localized manual for %s / %s',
    async (locale, state, label, help, guideLocale) => {
      await i18n.changeLanguage(locale)
      natState.status = {
        ...natState.status!,
        state,
        retryAttempt: state === NatState.Failed ? 3 : 0,
      }
      renderBadge()

      fireEvent.click(screen.getByRole('button', { name: label }))
      fireEvent.click(await screen.findByRole('menuitem', { name: help }))

      expect(openExternal).toHaveBeenCalledWith(
        EXTERNAL_URLS.motrix.manual.natTroubleshooting[guideLocale]
      )
    }
  )

  it('keeps automatic retries in the menu without changing the badge label', async () => {
    natState.status = { ...natState.status!, retryAttempt: 1 }
    renderBadge()
    fireEvent.click(screen.getByRole('button', { name: 'NAT mapping' }))
    expect(await screen.findByText('Automatic retries (1/3)')).toBeVisible()
    expect(
      screen.queryByRole('menuitem', { name: 'Retry' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('menuitem', { name: 'Network guide' })
    ).toBeVisible()
  })

  it('explains mapped ports in terms of BT connections', async () => {
    natState.status = {
      ...natState.status!,
      state: NatState.Active,
      retryAttempt: 0,
    }
    renderBadge()
    fireEvent.click(screen.getByRole('button', { name: 'NAT mapped' }))
    expect(
      await screen.findByText(/Helps other BT peers connect to you/)
    ).toBeVisible()
  })

  it('starts a new mapping attempt only when requested', async () => {
    renderBadge()
    expect(invoke).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'NAT mapping' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Retry' }))
    expect(invoke).toHaveBeenCalledExactlyOnceWith(Commands.EnableNat)
  })

  it('can turn off mapping after retries are exhausted', async () => {
    renderBadge()
    fireEvent.click(screen.getByRole('button', { name: 'NAT mapping' }))
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Turn off NAT mapping' })
    )
    expect(invoke).toHaveBeenCalledExactlyOnceWith(Commands.DisableNat)
  })

  it('opens network settings', async () => {
    renderBadge()
    fireEvent.click(screen.getByRole('button', { name: 'NAT mapping' }))
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'Network settings' })
    )
    expect(
      await screen.findByRole('heading', { name: 'Network preferences' })
    ).toBeVisible()
  })

  it('hides the badge while status is unknown or mapping is off', () => {
    natState.status = null
    const view = renderBadge()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    view.unmount()
    natState.status = {
      state: NatState.Active,
      enabled: false,
      activeMappings: [],
      gatewayInfo: null,
      lastError: null,
      lastDiagnostic: null,
      retryAttempt: 0,
      maxRetries: 3,
    }
    renderBadge()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
