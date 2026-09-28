import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FormProvider, useForm } from 'react-hook-form'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import type { PlatformServices } from '@renderer/platform/services'
import { PlatformServicesProvider } from '@renderer/platform/services'
import { UrlTextarea } from './url-textarea'

function Wrapper({
  children,
  onValidate,
}: {
  children: React.ReactNode
  onValidate?: () => void
}) {
  const form = useForm({
    defaultValues: { tab: 'links', urls: '', saveDir: '/d' },
    mode: 'onTouched',
    resolver: onValidate
      ? (values) => {
          onValidate()
          return { values, errors: {} }
        }
      : undefined,
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
  // jsdom has no layout; wrapped-line geometry is exercised in Electron E2E.
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(600)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(22)
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(
      function (this: HTMLElement) {
        return 12 + Number(this.dataset.urlLine ?? 0) * 22
      }
    )
  })
  afterEach(() => vi.restoreAllMocks())

  it('does not run the form resolver for an empty or cleared URL draft', async () => {
    const user = userEvent.setup()
    const onValidate = vi.fn()
    render(
      <Wrapper onValidate={onValidate}>
        <UrlTextarea name="urls" />
      </Wrapper>
    )
    const textbox = screen.getByRole('textbox')
    await user.click(textbox)
    await user.tab()
    expect(onValidate).not.toHaveBeenCalled()
    await user.type(textbox, 'https://example.com')
    await user.tab()
    expect(onValidate).toHaveBeenCalled()
    onValidate.mockClear()
    await user.clear(textbox)
    await user.type(textbox, '  {Enter}  ')
    await user.tab()
    expect(onValidate).not.toHaveBeenCalled()
  })

  it('corrects one path explicitly, preserves the query, and supports undo', async () => {
    const user = userEvent.setup()
    render(
      <Wrapper>
        <UrlTextarea name="urls" />
      </Wrapper>
    )
    const textbox = screen.getByRole('textbox')
    const original = 'https://a/dir\\file?sig=%2f+%252F'
    await user.type(textbox, original)
    await user.tab()
    await user.click(screen.getByRole('button', { name: /^Line 1:/ }))
    await user.click(
      screen.getByRole('button', { name: 'Encode as literal characters' })
    )
    expect(textbox).toHaveValue('https://a/dir%5Cfile?sig=%2f+%252F')
    await user.click(
      screen.getByRole('button', { name: 'Undo URL correction' })
    )
    expect(textbox).toHaveValue(original)
  })
  it('expands a pasted hash when replacing a selected line', async () => {
    const user = userEvent.setup()
    render(
      <Wrapper>
        <UrlTextarea name="urls" />
      </Wrapper>
    )
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement
    await user.type(textbox, 'https://a/b')
    textbox.setSelectionRange(0, textbox.value.length)
    const hash = 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc'
    await user.paste(hash)
    expect(textbox).toHaveValue(`magnet:?xt=urn:btih:${hash}`)
    expect(screen.getByText(/1 URL/i)).toBeInTheDocument()
  })

  it('defers hash reflow while choosing a correction and undoes only that correction', async () => {
    const user = userEvent.setup()
    render(
      <Wrapper>
        <UrlTextarea name="urls" />
      </Wrapper>
    )
    const textbox = screen.getByRole('textbox')
    const hash = 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc'
    const url = 'https://example.com/dir\\file'
    await user.click(textbox)
    fireEvent.change(textbox, { target: { value: `${hash}\n${url}` } })
    await user.click(screen.getByRole('button', { name: /^Line 2:/ }))
    const correction = screen.getByRole('button', {
      name: 'Encode as literal characters',
    })
    act(() => correction.focus())
    expect(correction).toHaveFocus()
    expect(textbox).toHaveValue(`${hash}\n${url}`)
    await user.click(correction)
    expect(textbox).toHaveValue(
      `magnet:?xt=urn:btih:${hash}\nhttps://example.com/dir%5Cfile`
    )
    await user.click(
      screen.getByRole('button', { name: 'Undo URL correction' })
    )
    expect(textbox).toHaveValue(`magnet:?xt=urn:btih:${hash}\n${url}`)
  })

  it('preserves a hash pasted as a URL query value', async () => {
    const user = userEvent.setup()
    render(
      <Wrapper>
        <UrlTextarea name="urls" />
      </Wrapper>
    )
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement
    await user.type(textbox, 'https://a/b?hash=')
    const hash = 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc'
    await user.paste(hash)
    await user.tab()
    expect(textbox).toHaveValue(`https://a/b?hash=${hash}`)
  })

  it('counts typed hashes as valid and expands them on blur, preserving other lines', async () => {
    const user = userEvent.setup()
    render(
      <Wrapper>
        <UrlTextarea name="urls" />
      </Wrapper>
    )
    const textbox = screen.getByRole('textbox')
    const hash = 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc'
    await user.type(textbox, `https://a/b{Enter}${hash}{Enter}bad text`)
    expect(textbox).toHaveValue(`https://a/b\n${hash}\nbad text`)
    expect(
      screen.getByRole('status', { name: '2 valid, 1 invalid' })
    ).toBeInTheDocument()
    await user.tab()
    // The first Tab focuses the inline diagnostic; the next leaves the editor.
    await user.tab()
    expect(textbox).toHaveValue(
      `https://a/b\nmagnet:?xt=urn:btih:${hash}\nbad text`
    )
  })

  it('preserves invalid lines in a mixed paste while expanding hashes on blur', async () => {
    const user = userEvent.setup()
    render(
      <Wrapper>
        <UrlTextarea name="urls" />
      </Wrapper>
    )
    const textbox = screen.getByRole('textbox')
    const hash = 'a03e3f9a05341aa336e9d9d3f06b33cddafe0bdc'
    await user.click(textbox)
    await user.paste(`${hash}\ninvalid\nhttps://a/b`)
    await user.tab()
    await user.tab()
    expect(textbox).toHaveValue(
      `magnet:?xt=urn:btih:${hash}\ninvalid\nhttps://a/b`
    )
  })

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
    expect(
      screen.getByRole('status', { name: '1 valid, 1 invalid' })
    ).toBeInTheDocument()
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

  it('exposes an error tooltip and selects the exact original token on click', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <Wrapper>
        <UrlTextarea name="urls" />
      </Wrapper>
    )
    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement
    await user.click(textbox)
    await user.paste('https://example.com/file\n  htps://example.com')
    const marker = screen.getByRole('button', {
      name: 'Line 2: This URL protocol is not supported for this download.',
    })
    expect(container.querySelector('.url-editor-error')).toHaveTextContent(
      'htps'
    )
    expect(screen.queryByText(/Review .*invalid line/)).not.toBeInTheDocument()
    await user.hover(marker)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Line 2: This URL protocol is not supported for this download.'
    )
    await user.click(marker)
    expect(textbox).toHaveFocus()
    expect(
      textbox.value.slice(textbox.selectionStart, textbox.selectionEnd)
    ).toBe('htps')
    await user.keyboard('https')
    expect(
      screen.queryByRole('button', { name: /^Line 2:/ })
    ).not.toBeInTheDocument()
  })

  it('keeps native text visible during IME composition', async () => {
    const { container } = render(
      <Wrapper>
        <UrlTextarea name="urls" />
      </Wrapper>
    )
    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'htps://example.com' } })
    fireEvent.compositionStart(textbox)
    expect(container.querySelector('.url-editor')).toHaveAttribute(
      'data-enhanced',
      'false'
    )
    expect(
      screen.queryByRole('button', { name: /^Line 1:/ })
    ).not.toBeInTheDocument()
    fireEvent.compositionEnd(textbox)
    await waitFor(() =>
      expect(container.querySelector('.url-editor')).toHaveAttribute(
        'data-enhanced',
        'true'
      )
    )
    expect(screen.getByRole('button', { name: /^Line 1:/ })).toBeInTheDocument()
  })

  it('uses bounded markup and one diagnostic for oversized pasted input', () => {
    const { container } = render(
      <Wrapper>
        <UrlTextarea name="urls" />
      </Wrapper>
    )
    const textbox = screen.getByRole('textbox')
    const raw = 'htps://example.com\n'.repeat(1001)
    fireEvent.change(textbox, { target: { value: raw } })
    expect(textbox).toHaveValue(raw)
    expect(container.querySelector('.url-editor')).toHaveAttribute(
      'data-enhanced',
      'false'
    )
    expect(container.querySelectorAll('[data-url-line]')).toHaveLength(0)
    expect(screen.getAllByRole('button', { name: /^Line 1:/ })).toHaveLength(1)
  })
})
