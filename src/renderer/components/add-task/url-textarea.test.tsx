import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FormProvider, useForm } from 'react-hook-form'
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import type { PlatformServices } from '@renderer/platform/services'
import { PlatformServicesProvider } from '@renderer/platform/services'
import { UrlTextarea } from './url-textarea'

function Wrapper({ children }: { children: React.ReactNode }) {
  const form = useForm({
    defaultValues: { tab: 'links', urls: '', saveDir: '/d' },
  })
  const mockServices: PlatformServices = {
    kind: 'electron',
    pickSaveDir: vi.fn(),
    closeHost: vi.fn(),
    readClipboard: vi.fn().mockResolvedValue(''),
    openExternal: vi.fn(),
    notify: vi.fn(),
  }
  return (
    <PlatformServicesProvider services={mockServices}>
      <FormProvider {...form}>{children}</FormProvider>
    </PlatformServicesProvider>
  )
}

describe('UrlTextarea', () => {
  it('renders a textarea', () => {
    render(
      <Wrapper>
        <UrlTextarea name="urls" />
      </Wrapper>
    )
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('shows a counter when URLs are present', async () => {
    const user = userEvent.setup()
    render(
      <Wrapper>
        <UrlTextarea name="urls" />
      </Wrapper>
    )
    await user.type(screen.getByRole('textbox'), 'https://a/b')
    expect(screen.getByText(/1 URL/i)).toBeInTheDocument()
  })

  it('shows invalid count when URLs fail validation', async () => {
    const user = userEvent.setup()
    render(
      <Wrapper>
        <UrlTextarea name="urls" />
      </Wrapper>
    )
    await user.type(screen.getByRole('textbox'), 'https://a/b{Enter}not-a-url')
    expect(screen.getByText(/1 invalid/i)).toBeInTheDocument()
  })

  // Plain URL pastes are handled natively — the onPaste handler only
  // intercepts when the interpreter has side effects (magnet/curl).
  // These tests verify the native behavior is no longer swallowed.
  it('paste with full selection replaces content (native semantics)', async () => {
    const user = userEvent.setup()
    render(
      <Wrapper>
        <UrlTextarea name="urls" />
      </Wrapper>
    )
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement
    await user.type(textbox, 'https://a/b')
    textbox.setSelectionRange(0, textbox.value.length)
    await user.paste('https://c/d')
    expect(textbox.value).toBe('https://c/d')
  })
})
