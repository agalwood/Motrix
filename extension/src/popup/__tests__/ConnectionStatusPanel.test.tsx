import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { send } from '@/background/MessageBus'
import { ConnectionStatusPanel } from '@/popup/ConnectionStatusPanel'
import type { PopupState } from '@/popup/usePopupState'
import { i18n } from '@/shared/i18n'

vi.mock('@/background/MessageBus', () => ({ send: vi.fn() }))
const result = {
  startedAt: '2026-09-09T00:00:00Z',
  durationMs: 8,
  backend: 'local' as const,
  checks: [
    {
      id: 'native-host',
      status: 'fail' as const,
      detail: 'Native-host allowlist check: forbidden',
      durationMs: 2,
    },
  ],
}

async function diagnose(
  user: ReturnType<typeof userEvent.setup>
): Promise<void> {
  await user.click(
    screen.getByRole('button', { name: i18n.t('popup.diagnostics.run') })
  )
  await screen.findByRole('region', { name: i18n.t('popup.diagnostics.title') })
}

function baseState(overrides: Partial<PopupState> = {}): PopupState {
  return {
    loading: false,
    connection: 'disconnected',
    pairing: 'stored',
    phase: 'idle',
    attemptIntent: null,
    lastError: null,
    lastErrorReason: null,
    endpoint: null,
    server: null,
    backoff: null,
    recoveryExhaustedUnattended: false,
    degraded: false,
    pairingCode: null,
    ...overrides,
  } as PopupState
}

describe('ConnectionStatusPanel error copy', () => {
  it('renders localized copy for a typed failure reason, never the raw message', () => {
    render(
      <ConnectionStatusPanel
        state={baseState({
          lastError: 'the peer refused the pairing',
          lastErrorReason: 'peerRejected',
        })}
        onReconnect={vi.fn()}
      />
    )
    expect(
      screen.getByText(i18n.t('errors.connection.peerRejected'))
    ).toBeTruthy()
    expect(screen.queryByText('the peer refused the pairing')).toBeNull()
  })

  it('renders generic copy for an untyped error', () => {
    render(
      <ConnectionStatusPanel
        state={baseState({ lastError: 'ECONNREFUSED 127.0.0.1:16802' })}
        onReconnect={vi.fn()}
      />
    )
    expect(screen.getByText(i18n.t('errors.connection.generic'))).toBeTruthy()
    expect(screen.queryByText(/ECONNREFUSED/)).toBeNull()
  })

  it.each([
    ['backendUpgradeRequired', 'errors.connection.backendUpgradeRequired'],
    ['extensionUpgradeRequired', 'errors.connection.extensionUpgradeRequired'],
    ['unsupportedRemote', 'errors.connection.unsupportedRemote'],
    [
      'remoteDiscoveryUnavailable',
      'errors.connection.remoteDiscoveryUnavailable',
    ],
    ['remotePairingUnavailable', 'errors.connection.remotePairingUnavailable'],
  ])('renders directional compatibility copy for %s', (reason, key) => {
    render(
      <ConnectionStatusPanel
        state={baseState({
          lastError: `developer-only: ${reason}`,
          lastErrorReason: reason,
        })}
        onReconnect={vi.fn()}
      />
    )
    expect(screen.getByText(i18n.t(key))).toBeTruthy()
    expect(screen.queryByText(`developer-only: ${reason}`)).toBeNull()
  })

  it('shows no error alert when there is no error', () => {
    render(<ConnectionStatusPanel state={baseState()} onReconnect={vi.fn()} />)
    expect(screen.queryByText(i18n.t('errors.connection.generic'))).toBeNull()
    expect(
      screen.queryByRole('button', {
        name: i18n.t('options.help.copyDiagnostics'),
      })
    ).toBeNull()
  })

  it('disables the connect button and counts down while the §7.3 backoff is active', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      render(
        <ConnectionStatusPanel
          state={baseState({ backoff: { retryAtMs: 1_000_000 + 30_000 } })}
          onReconnect={vi.fn()}
        />
      )
      const button = screen.getByRole('button', {
        name: i18n.t('popup.pairing.retryIn', { seconds: 30 }),
      }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('acknowledges a connect click immediately by entering a pending state', async () => {
    const onReconnect = vi.fn()
    render(
      <ConnectionStatusPanel state={baseState()} onReconnect={onReconnect} />
    )
    const button = screen.getByRole('button', {
      name: i18n.t('popup.integration.viewTasks'),
    }) as HTMLButtonElement
    await userEvent.click(button)
    expect(onReconnect).toHaveBeenCalledOnce()
    expect(button.disabled).toBe(true)
  })

  it('reopens a pending pairing prompt instead of starting another connection', async () => {
    const onReconnect = vi.fn()
    const onShowPairing = vi.fn()
    render(
      <ConnectionStatusPanel
        state={baseState({
          connection: 'awaiting-code',
          pairingCode: {
            run: 1,
            maxRuns: 3,
            attemptsRemaining: null,
            deadlineMs: Date.now() + 60_000,
          },
        })}
        onReconnect={onReconnect}
        onShowPairing={onShowPairing}
      />
    )

    await userEvent.click(
      screen.getByRole('button', {
        name: i18n.t('popup.pairing.enterCode'),
      })
    )
    expect(onShowPairing).toHaveBeenCalledOnce()
    expect(onReconnect).not.toHaveBeenCalled()
  })
})

describe('ConnectionStatusPanel diagnostic copy', () => {
  beforeEach(() => {
    vi.mocked(send).mockResolvedValue(result)
    browser.runtime.getManifest = vi.fn(() => ({
      manifest_version: 3,
      name: 'Motrix',
      version: '0.1.7',
    }))
  })

  it('copies the full error with environment data without reconnecting', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    const onReconnect = vi.fn()
    render(
      <ConnectionStatusPanel
        state={baseState({
          lastError: 'ECONNREFUSED 127.0.0.1:16802',
          lastErrorReason: 'channelUnavailable',
        })}
        onReconnect={onReconnect}
      />
    )

    await diagnose(user)
    await user.click(
      screen.getByRole('button', {
        name: i18n.t('options.help.copyDiagnostics'),
      })
    )

    const text = writeText.mock.calls[0]?.[0] ?? ''
    expect(text).toContain('ECONNREFUSED 127.0.0.1:16802')
    expect(text).toContain('channelUnavailable')
    expect(text).toContain('0.1.7')
    expect(text).toContain(navigator.userAgent)
    expect(text).toContain('test-extension-id')
    expect(text).toContain('Native-host allowlist check: forbidden')
    expect(
      screen.getByRole('button', { name: i18n.t('options.help.copied') })
    ).toBeTruthy()
    expect(onReconnect).not.toHaveBeenCalled()
  })

  it('reports clipboard denial and lets the user retry', async () => {
    const user = userEvent.setup()
    const writeText = vi
      .spyOn(navigator.clipboard, 'writeText')
      .mockRejectedValueOnce(new DOMException('Denied', 'NotAllowedError'))
      .mockResolvedValue(undefined)
    render(
      <ConnectionStatusPanel
        state={baseState({ lastError: 'NM bootstrap timeout' })}
        onReconnect={vi.fn()}
      />
    )
    await diagnose(user)
    const button = screen.getByRole('button', {
      name: i18n.t('options.help.copyDiagnostics'),
    })
    await user.click(button)
    expect(
      screen.getByText(i18n.t('errors.connection.diagnosticsCopyFailed'))
    ).toBeTruthy()
    expect(screen.queryByText(i18n.t('options.help.copied'))).toBeNull()

    await user.click(button)
    expect(writeText).toHaveBeenCalledTimes(2)
    expect(screen.getByText(i18n.t('options.help.copied'))).toBeTruthy()
    expect(
      screen.queryByText(i18n.t('errors.connection.diagnosticsCopyFailed'))
    ).toBeNull()
  })

  it('resets copied feedback and copies the new error when the failure changes', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    const { rerender } = render(
      <ConnectionStatusPanel
        state={baseState({ lastError: 'old failure' })}
        onReconnect={vi.fn()}
      />
    )
    await diagnose(user)
    await user.click(
      screen.getByRole('button', {
        name: i18n.t('options.help.copyDiagnostics'),
      })
    )

    rerender(
      <ConnectionStatusPanel
        state={baseState({ lastError: 'new failure' })}
        onReconnect={vi.fn()}
      />
    )
    expect(
      screen.queryByRole('region', { name: i18n.t('popup.diagnostics.title') })
    ).toBeNull()
    await diagnose(user)
    await user.click(
      screen.getByRole('button', {
        name: i18n.t('options.help.copyDiagnostics'),
      })
    )
    expect(writeText.mock.calls.at(-1)?.[0]).toContain('new failure')
    expect(writeText.mock.calls.at(-1)?.[0]).not.toContain('old failure')
  })

  it('folds advanced guidance and replaces setup tips with on-demand results', async () => {
    const user = userEvent.setup()
    render(
      <ConnectionStatusPanel
        state={baseState({
          lastError: 'connection failed',
          endpoint: {
            version: 3,
            activeEndpointId: 'local',
            servers: [],
            cleanupTombstones: [],
          },
        })}
        onReconnect={vi.fn()}
      />
    )
    const advanced = screen
      .getByText(i18n.t('popup.diagnostics.allowlistHint'))
      .closest('details')!
    expect(advanced.open).toBe(false)
    await user.click(screen.getByText(i18n.t('popup.diagnostics.advanced')))
    expect(advanced.open).toBe(true)
    expect(
      screen.getByText(i18n.t('popup.diagnostics.firstLaunchHint'))
    ).toBeTruthy()
    expect(
      screen
        .getByRole('link', {
          name: i18n.t('popup.diagnostics.appReleases'),
        })
        .getAttribute('href')
    ).toBe('https://github.com/agalwood/Motrix/releases')
    expect(send).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('button', {
        name: i18n.t('options.help.copyDiagnostics'),
      })
    ).toBeNull()
    await diagnose(user)
    expect(send).toHaveBeenCalledWith('bg.runConnectionDiagnostics', {
      endpointId: 'local',
    })
    expect(
      screen.queryByText(i18n.t('popup.diagnostics.firstLaunchHint'))
    ).toBeNull()
    expect(screen.queryByText(i18n.t('popup.diagnostics.advanced'))).toBeNull()
  })

  it('starts each new diagnostic report at the top of its scroll area', async () => {
    const user = userEvent.setup()
    render(
      <ConnectionStatusPanel
        state={baseState({ lastError: 'connection failed' })}
        onReconnect={vi.fn()}
      />
    )
    await diagnose(user)
    const scrollArea = screen.getByRole('region', {
      name: i18n.t('popup.diagnostics.title'),
    }).parentElement!
    scrollArea.scrollTop = 200
    await user.click(
      screen.getByRole('button', { name: i18n.t('popup.diagnostics.rerun') })
    )
    await screen.findByRole('region', {
      name: i18n.t('popup.diagnostics.title'),
    })
    expect(scrollArea.scrollTop).toBe(0)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('disables diagnosis while running and ignores results after the backend changes', async () => {
    let complete!: (value: typeof result) => void
    vi.mocked(send).mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve
      })
    )
    const user = userEvent.setup()
    const state = baseState({
      lastError: 'failed',
      endpoint: {
        version: 3,
        activeEndpointId: 'local',
        servers: [],
        cleanupTombstones: [],
      },
    })
    const { rerender } = render(
      <ConnectionStatusPanel state={state} onReconnect={vi.fn()} />
    )
    await user.click(
      screen.getByRole('button', { name: i18n.t('popup.diagnostics.run') })
    )
    expect(
      (
        screen.getByRole('button', {
          name: i18n.t('popup.diagnostics.running'),
        }) as HTMLButtonElement
      ).disabled
    ).toBe(true)
    rerender(
      <ConnectionStatusPanel
        state={{
          ...state,
          endpoint: { ...state.endpoint!, activeEndpointId: 'remote' },
        }}
        onReconnect={vi.fn()}
      />
    )
    expect(
      screen.queryByText(i18n.t('popup.diagnostics.allowlistHint'))
    ).toBeNull()
    expect(
      screen.queryByText(i18n.t('popup.diagnostics.firstLaunchHint'))
    ).toBeNull()
    expect(
      screen.queryByRole('link', {
        name: i18n.t('popup.diagnostics.appReleases'),
      })
    ).toBeNull()
    await act(async () => complete(result))
    expect(
      screen.queryByRole('region', { name: i18n.t('popup.diagnostics.title') })
    ).toBeNull()
  })

  it('provides a copyable fallback if the background cannot respond', async () => {
    vi.mocked(send).mockRejectedValueOnce(
      new Error('Could not establish connection. Receiving end does not exist.')
    )
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    render(
      <ConnectionStatusPanel
        state={baseState({ lastError: 'original failure' })}
        onReconnect={vi.fn()}
      />
    )
    await diagnose(user)
    await user.click(
      screen.getByRole('button', {
        name: i18n.t('options.help.copyDiagnostics'),
      })
    )
    expect(writeText.mock.calls[0]?.[0]).toContain(
      'Receiving end does not exist'
    )
    expect(writeText.mock.calls[0]?.[0]).toContain('original failure')
  })

  it('keeps an unattended offline pairing quiet and offers task access', async () => {
    render(
      <ConnectionStatusPanel
        state={baseState({
          recoveryExhaustedUnattended: true,
          lastError: 'not running',
          attemptIntent: 'background-probe',
        })}
        onReconnect={vi.fn()}
      />
    )
    expect(
      screen.queryByRole('button', { name: i18n.t('popup.diagnostics.run') })
    ).toBeNull()
    expect(
      screen.getByText(i18n.t('popup.integration.pairedTitle'))
    ).toBeTruthy()
    expect(
      screen.getByRole('button', {
        name: i18n.t('popup.integration.viewTasks'),
      })
    ).toBeTruthy()
  })

  it('leaves a readable report after the background response times out', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(send).mockReturnValueOnce(new Promise(() => {}))
      render(
        <ConnectionStatusPanel
          state={baseState({ lastError: 'original error' })}
          onReconnect={vi.fn()}
        />
      )
      fireEvent.click(
        screen.getByRole('button', { name: i18n.t('popup.diagnostics.run') })
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000)
      })
      expect(
        screen.getByRole('region', {
          name: i18n.t('popup.diagnostics.title'),
        }).textContent
      ).toContain('Diagnostic check timed out')
      expect(
        screen.getByRole('button', {
          name: i18n.t('options.help.copyDiagnostics'),
        })
      ).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
