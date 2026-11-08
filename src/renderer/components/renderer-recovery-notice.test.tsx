import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { i18n } from '@renderer/lib/i18n'
import { Commands } from '@shared/protocol/commands'
import type { RendererSession } from '@shared/schemas/renderer-health'
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RendererSubmissionNotice,
  RendererToaster,
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
  transport: { invoke: mocks.invoke, platform: 'darwin' },
}))

const restoredToast = () =>
  within(screen.getByLabelText('Notifications')).queryByText(
    'Interface restored'
  )

afterEach(async () => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  mocks.session = undefined
  mocks.invoke.mockClear()
  await i18n.changeLanguage('en-US')
})

describe('renderer recovery feedback', () => {
  it('keeps ordinary startup quiet', () => {
    mocks.session = { recovered: false, submissionNeedsReview: false }
    render(
      <>
        <RendererToaster />
        <RendererSubmissionNotice />
      </>
    )
    expect(restoredToast()).not.toBeInTheDocument()
    expect(screen.queryByText(/previous submission/)).not.toBeInTheDocument()
  })

  it('briefly confirms recovery through the shared toast without moving keyboard focus', async () => {
    vi.useFakeTimers()
    mocks.session = { recovered: true, submissionNeedsReview: false }
    render(<input aria-label="Task URL" />)
    screen.getByRole('textbox').focus()
    render(
      <StrictMode>
        <RendererToaster />
      </StrictMode>
    )
    expect(restoredToast()).toBeInTheDocument()
    expect(screen.getByLabelText('Close')).toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveFocus()
    await act(async () => vi.advanceTimersByTime(3_200))
    expect(restoredToast()).not.toBeInTheDocument()
    expect(screen.getByRole('textbox')).toHaveFocus()
  })

  it('waits for a recovered background window to become visible and never repeats expired feedback', async () => {
    vi.useFakeTimers()
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    mocks.session = { recovered: true, submissionNeedsReview: false }
    render(<RendererToaster />)
    await act(async () => vi.advanceTimersByTime(10_000))
    expect(restoredToast()).not.toBeInTheDocument()
    hidden.mockReturnValue(false)
    fireEvent(document, new Event('visibilitychange'))
    expect(restoredToast()).toBeInTheDocument()
    await act(async () => vi.advanceTimersByTime(3_200))
    expect(restoredToast()).not.toBeInTheDocument()
    hidden.mockReturnValue(true)
    fireEvent(document, new Event('visibilitychange'))
    hidden.mockReturnValue(false)
    fireEvent(document, new Event('visibilitychange'))
    expect(restoredToast()).not.toBeInTheDocument()
  })

  it('shows one toast in Strict Mode and does not repeat dismissed feedback after remount or locale changes', async () => {
    mocks.session = { recovered: true, submissionNeedsReview: false }
    const view = render(
      <StrictMode>
        <RendererToaster />
      </StrictMode>
    )
    expect(restoredToast()).toBeInTheDocument()
    expect(screen.getAllByLabelText('Close')).toHaveLength(1)
    fireEvent.click(screen.getByLabelText('Close'))
    expect(restoredToast()).not.toBeInTheDocument()
    view.unmount()
    render(<RendererToaster />)
    expect(restoredToast()).not.toBeInTheDocument()
    await act(async () => i18n.changeLanguage('zh-CN'))
    expect(screen.queryByText('界面已恢复')).not.toBeInTheDocument()
  })

  it('removes pending visibility feedback when the host unmounts', () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    mocks.session = { recovered: true, submissionNeedsReview: false }
    const view = render(<RendererToaster />)
    view.unmount()
    hidden.mockReturnValue(false)
    fireEvent(document, new Event('visibilitychange'))
    // If the old listener published into the missing host, it would consume
    // this session and the mounted host could no longer display the toast.
    render(<RendererToaster />)
    expect(restoredToast()).toBeInTheDocument()
  })

  it('keeps uncertain submissions actionable until explicitly dismissed', async () => {
    vi.useFakeTimers()
    mocks.session = { recovered: true, submissionNeedsReview: true }
    render(
      <>
        <RendererToaster />
        <RendererSubmissionNotice />
      </>
    )
    expect(restoredToast()).not.toBeInTheDocument()
    await act(async () => vi.advanceTimersByTime(60_000))
    expect(screen.getByRole('status')).toHaveTextContent('previous submission')
    fireEvent.click(screen.getByRole('button', { name: 'Open downloads' }))
    expect(mocks.invoke).toHaveBeenCalledWith(Commands.ShowMainWindow)
    fireEvent.click(screen.getByLabelText('Close'))
    expect(screen.queryByText(/previous submission/)).not.toBeInTheDocument()
  })
})
