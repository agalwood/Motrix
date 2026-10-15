import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { PairingCodePanel } from '@/popup/PairingCodePanel'
import { i18n } from '@/shared/i18n'

describe('PairingCodePanel', () => {
  it('rejects an invalid code locally without dispatching a submit', async () => {
    const submit = vi.fn()
    render(<PairingCodePanel onSubmit={submit} />)
    await userEvent.type(screen.getByRole('textbox'), 'SHORT')
    await userEvent.click(screen.getByRole('button', { name: /pair/i }))
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByText(i18n.t('popup.pairing.codeInvalid'))).toBeTruthy()
  })

  it('submits the normalized code for a well-formed 8-character input', async () => {
    const submit = vi.fn()
    render(<PairingCodePanel onSubmit={submit} />)
    await userEvent.type(screen.getByRole('textbox'), 'mtx7k2q9')
    await userEvent.click(screen.getByRole('button', { name: /pair/i }))
    expect(submit).toHaveBeenCalledWith('MTX7K2Q9')
    expect(screen.queryByText(i18n.t('popup.pairing.codeInvalid'))).toBeNull()
  })

  it('folds confusable letters (O/I/L) and strips hyphens before submitting', async () => {
    const submit = vi.fn()
    render(<PairingCodePanel onSubmit={submit} />)
    // Strip "-" -> "OILABCDE" (8 chars) -> fold O->0, I->1, L->1 -> "011ABCDE".
    await userEvent.type(screen.getByRole('textbox'), 'OIL-ABCDE')
    await userEvent.click(screen.getByRole('button', { name: /pair/i }))
    expect(submit).toHaveBeenCalledWith('011ABCDE')
  })

  it('does not consume an attempt on repeated invalid submissions', async () => {
    const submit = vi.fn()
    render(<PairingCodePanel onSubmit={submit} />)
    const input = screen.getByRole('textbox')
    const button = screen.getByRole('button', { name: /pair/i })
    await userEvent.type(input, 'SHORT')
    await userEvent.click(button)
    await userEvent.clear(input)
    await userEvent.type(input, 'BAD')
    await userEvent.click(button)
    expect(submit).not.toHaveBeenCalled()
  })

  it('renders eight OTP slots in two groups with a separator', () => {
    const { container } = render(<PairingCodePanel onSubmit={vi.fn()} />)
    expect(
      container.querySelectorAll('[data-slot="input-otp-slot"]')
    ).toHaveLength(8)
    // Default size is the popup-compact one.
    expect(
      container
        .querySelector('[data-slot="input-otp-slot"]')
        ?.className.includes('size-8')
    ).toBe(true)
    expect(
      container.querySelectorAll('[data-slot="input-otp-group"]')
    ).toHaveLength(2)
    expect(
      container.querySelector('[data-slot="input-otp-separator"]')
    ).toBeTruthy()
  })

  it('renders the large slot size when asked (options dialog)', () => {
    const { container } = render(
      <PairingCodePanel onSubmit={vi.fn()} size="lg" />
    )
    const slot = container.querySelector('[data-slot="input-otp-slot"]')
    expect(slot?.className.includes('size-10')).toBe(true)
    expect(slot?.className.includes('size-8')).toBe(false)
  })

  it('stops accepting characters after the eighth', async () => {
    const submit = vi.fn()
    render(<PairingCodePanel onSubmit={submit} />)
    const input = screen.getByRole('textbox') as HTMLInputElement
    await userEvent.type(input, 'TOOLONGCODE')
    expect(input.value).toHaveLength(8)
    await userEvent.click(screen.getByRole('button', { name: /pair/i }))
    expect(submit).toHaveBeenCalledWith('T0010NGC')
  })

  it('accepts a pasted display-form code, stripping its hyphen', async () => {
    const submit = vi.fn()
    render(<PairingCodePanel onSubmit={submit} />)
    const input = screen.getByRole('textbox')
    await userEvent.click(input)
    await userEvent.paste('TKPP-1HS0')
    await userEvent.click(screen.getByRole('button', { name: /pair/i }))
    expect(submit).toHaveBeenCalledWith('TKPP1HS0')
  })

  it('shows the attempt count without any instanceId routing hint', () => {
    render(
      <PairingCodePanel
        onSubmit={vi.fn()}
        run={2}
        maxRuns={3}
        attemptsRemaining={1}
      />
    )
    expect(
      screen.getByText(
        i18n.t('popup.pairing.attemptOf', { run: 2, maxRuns: 3 }),
        { exact: false }
      )
    ).toBeTruthy()
    // §4.1's instanceId is a routing hint — a UUID means nothing to a
    // person, so the panel must not render one at all. Asserted with a
    // literal, not a locale key, so no dead catalog entry has to survive
    // just to feed this negative check.
    expect(screen.queryByText(/pairing code shown by/i)).toBeNull()
  })

  it('disables the input and button while disabled is set', () => {
    render(<PairingCodePanel onSubmit={vi.fn()} disabled />)
    expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(
      true
    )
    expect(
      (screen.getByRole('button', { name: /pair/i }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })
})
