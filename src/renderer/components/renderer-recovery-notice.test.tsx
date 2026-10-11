import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { Commands } from '@shared/protocol/commands'
import type { RendererSession } from '@shared/schemas/renderer-health'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RendererRecoveryStatus,
  RendererSubmissionNotice,
} from './renderer-recovery-notice'

const mocks = vi.hoisted(() => ({
  session: undefined as
    | Pick<RendererSession, 'recovered' | 'submissionNeedsReview'>
    | undefined,
  invoke: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@renderer/lib/renderer-health', () => ({
  rendererSession: () => mocks.session,
}))
vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: mocks.invoke },
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  mocks.session = undefined
  mocks.invoke.mockClear()
})

describe('renderer recovery feedback', () => {
  it('keeps ordinary startup quiet', () => {
    mocks.session = { recovered: false, submissionNeedsReview: false }
    const { container } = render(
      <>
        <RendererRecoveryStatus />
        <RendererSubmissionNotice />
      </>
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('briefly confirms recovery without moving keyboard focus', () => {
    vi.useFakeTimers()
    mocks.session = { recovered: true, submissionNeedsReview: false }
    render(
      <>
        <input aria-label="Task URL" />
        <RendererRecoveryStatus />
      </>
    )
    screen.getByRole('textbox').focus()
    expect(screen.getByRole('status')).toHaveTextContent('Interface restored')
    expect(screen.getByRole('textbox')).toHaveFocus()
    act(() => vi.advanceTimersByTime(3_200))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveFocus()
  })

  it('starts the brief feedback when a recovered background window becomes visible', () => {
    vi.useFakeTimers()
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    mocks.session = { recovered: true, submissionNeedsReview: false }
    render(<RendererRecoveryStatus />)
    act(() => vi.advanceTimersByTime(10_000))
    expect(screen.getByRole('status')).toBeInTheDocument()
    hidden.mockReturnValue(false)
    fireEvent(document, new Event('visibilitychange'))
    act(() => vi.advanceTimersByTime(3_200))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('keeps uncertain submissions actionable until explicitly dismissed', () => {
    vi.useFakeTimers()
    mocks.session = { recovered: true, submissionNeedsReview: true }
    render(
      <>
        <RendererRecoveryStatus />
        <RendererSubmissionNotice />
      </>
    )
    expect(screen.getAllByRole('status')).toHaveLength(1)
    act(() => vi.advanceTimersByTime(60_000))
    expect(screen.getByRole('status')).toHaveTextContent('previous submission')
    fireEvent.click(screen.getByRole('button', { name: 'Open downloads' }))
    expect(mocks.invoke).toHaveBeenCalledWith(Commands.ShowMainWindow)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
