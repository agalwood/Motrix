import '@testing-library/jest-dom/vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@renderer/lib/i18n'
import { i18n } from '@renderer/lib/i18n'
import { Toaster, toast } from './toast'

const openedIds: string[] = []
function add(options: Parameters<typeof toast.add>[0]) {
  let id = ''
  act(() => {
    id = toast.add(options)
  })
  openedIds.push(id)
  return id
}

afterEach(async () => {
  act(() => {
    for (const id of openedIds) toast.close(id)
  })
  openedIds.length = 0
  vi.useRealTimers()
  // Restore the default locale so a later test file sharing this i18n
  // singleton doesn't inherit zh-CN from the aria-label language-switch
  // test below (precedent: NotificationsPage's language-switch test).
  await i18n.changeLanguage('en-US')
})

describe('toast', () => {
  it('renders title, description and success icon for an added toast', async () => {
    const { baseElement } = render(<Toaster />)
    add({
      title: 'Saved',
      description: 'Tracker list updated',
      type: 'success',
    })
    expect(await screen.findByText('Saved')).toBeInTheDocument()
    expect(screen.getByText('Tracker list updated')).toBeInTheDocument()
    expect(baseElement.querySelector('svg.text-emerald-500')).not.toBeNull()
  })

  it('keeps a timeout: 0 toast mounted (no auto-dismiss)', async () => {
    vi.useFakeTimers()
    render(<Toaster />)
    add({ title: 'Engine failed', type: 'error', timeout: 0 })
    await act(async () => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.getByText('Engine failed')).toBeInTheDocument()
  })

  it('close(id) removes the toast', async () => {
    render(<Toaster />)
    const id = add({ title: 'Pending', timeout: 0 })
    expect(await screen.findByText('Pending')).toBeInTheDocument()
    act(() => toast.close(id))
    expect(screen.queryByText('Pending')).not.toBeInTheDocument()
  })

  it('close(unknown-id) is a no-op and leaves other toasts mounted', async () => {
    render(<Toaster />)
    const id = add({ title: 'Still here', timeout: 0 })
    expect(await screen.findByText('Still here')).toBeInTheDocument()
    expect(() => act(() => toast.close('unknown-id'))).not.toThrow()
    expect(screen.getByText('Still here')).toBeInTheDocument()
    act(() => toast.close(id))
  })

  it('renders an action button from actionProps and fires onClick', async () => {
    render(<Toaster />)
    const onClick = vi.fn()
    add({
      title: 'Failed',
      type: 'error',
      timeout: 0,
      actionProps: { children: 'Open diagnostics', onClick },
    })
    await userEvent.click(
      await screen.findByRole('button', { name: 'Open diagnostics' })
    )
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('viewport stacks above the modal layer and clamps to narrow viewports', async () => {
    const { baseElement } = render(<Toaster />)
    add({ title: 'probe' })
    await screen.findByText('probe')
    const viewport = baseElement.querySelector('[class*="z-[100]"]')
    expect(viewport).not.toBeNull()
    expect(viewport?.className).toContain('max-w-[calc(100vw-2rem)]')
  })

  it('labels the viewport region for screen readers, translated with the locale', async () => {
    const { baseElement } = render(<Toaster />)
    add({ title: 'probe region' })
    await screen.findByText('probe region')

    // Asserting the English copy alone would just restate Base UI's own
    // built-in default ('Notifications') rather than prove this app wires
    // its own i18n through — switch locale and check the label actually
    // tracks it (precedent: NotificationsPage's language-switch test).
    await act(async () => {
      await i18n.changeLanguage('zh-CN')
    })

    const viewport = baseElement.querySelector('[class*="z-[100]"]')
    expect(viewport).toHaveAttribute('aria-label', '通知')
  })

  it('styles limited toasts as invisible AND opacity-0 — discrete removal plus the fade', async () => {
    const { baseElement } = render(<Toaster />)
    add({ title: 'probe limited' })
    await screen.findByText('probe limited')
    const root = baseElement.querySelector('[class*="data-limited:invisible"]')
    expect(root).not.toBeNull()
    // `invisible` alone pulls the toast out of the a11y tree once limited,
    // but visibility transitions discretely (no fade) — `opacity-0`
    // alongside it is what gives the actual fade-out.
    expect(root?.className).toContain('data-limited:opacity-0')
    expect(root?.className).toContain('data-limited:pointer-events-none')
  })

  describe('pairing prompt branch', () => {
    it('renders cli copy (title/userCode) and wires Allow/Deny to the injected callbacks', async () => {
      render(<Toaster />)
      const onAllow = vi.fn()
      const onDeny = vi.fn()
      add({
        id: 'cli:REQ1',
        timeout: 0,
        priority: 'high',
        data: {
          pairRequest: {
            kind: 'cli',
            requestId: 'REQ1',
            userCode: 'WXYZ-2345',
            clientName: 'Motrix CLI',
            clientVersion: '1.0.0',
            onAllow,
            onDeny,
          },
        },
      })

      expect(
        await screen.findByText('Motrix CLI wants to pair with Motrix')
      ).toBeInTheDocument()
      expect(
        screen.getByText('Verification code: WXYZ-2345')
      ).toBeInTheDocument()

      // A `priority: 'high'` toast (per the pairing contract) renders
      // `aria-hidden="true"` on its own Toast.Root until it gains focus —
      // Base UI's screen-reader courtesy of relying on the aria-live alert
      // region for the announcement first. `hidden: true` opts the role
      // query back in; it doesn't change click behavior, only what
      // getByRole is willing to see.
      await userEvent.click(
        screen.getByRole('button', { name: 'Allow', hidden: true })
      )
      expect(onAllow).toHaveBeenCalledOnce()
      expect(onDeny).not.toHaveBeenCalled()

      await userEvent.click(
        screen.getByRole('button', { name: "Don't allow", hidden: true })
      )
      expect(onDeny).toHaveBeenCalledOnce()
    })

    it('renders extension copy (title/browser) for an extension-kind request', async () => {
      render(<Toaster />)
      add({
        id: 'chromium:ext-1:nonce',
        timeout: 0,
        priority: 'high',
        data: {
          pairRequest: {
            kind: 'extension',
            pairingNonce: 'nonce',
            extensionId: 'ext-1',
            extensionName: 'Motrix Helper',
            extensionVersion: '1.0',
            browser: 'chromium',
            onAllow: vi.fn(),
            onDeny: vi.fn(),
          },
        },
      })

      expect(
        await screen.findByText('Motrix Helper wants to connect to Motrix')
      ).toBeInTheDocument()
      expect(screen.getByText('From Chrome / Edge')).toBeInTheDocument()
    })

    it('routes the × close button through the toast onClose (dismiss-as-deny wiring)', async () => {
      const { baseElement } = render(<Toaster />)
      const onClose = vi.fn()
      add({
        id: 'cli:REQ2',
        timeout: 0,
        priority: 'high',
        data: {
          pairRequest: {
            kind: 'cli',
            requestId: 'REQ2',
            userCode: 'AAAA-1111',
            clientName: 'Motrix CLI',
            clientVersion: '1.0.0',
            onAllow: vi.fn(),
            onDeny: vi.fn(),
          },
        },
        onClose,
      })

      await screen.findByText('Verification code: AAAA-1111')
      // The × button is `aria-hidden` until focused/expanded (Base UI's
      // screen-reader courtesy — same as the Allow/Deny case above), and
      // that in turn makes dom-accessibility-api report an empty
      // accessible name even with `hidden: true`, so a role query can't
      // find it by name here. Grab it by its stable aria-label attribute
      // instead — still a real DOM node, still a real click.
      const closeButton = baseElement.querySelector(
        'button[aria-label="Close"]'
      )
      expect(closeButton).not.toBeNull()
      await userEvent.click(closeButton as HTMLElement)
      expect(onClose).toHaveBeenCalledOnce()
    })

    it('adding the same id twice upserts one prompt (pins the reload-recovery add-in-place semantics)', async () => {
      render(<Toaster />)
      const pairingOptions = () => ({
        id: 'cli:REQ3',
        timeout: 0,
        priority: 'high' as const,
        data: {
          pairRequest: {
            kind: 'cli' as const,
            requestId: 'REQ3',
            userCode: 'CCCC-3333',
            clientName: 'Motrix CLI',
            clientVersion: '1.0.0',
            onAllow: vi.fn(),
            onDeny: vi.fn(),
          },
        },
      })

      add(pairingOptions())
      await screen.findByText('Verification code: CCCC-3333')

      // What `usePairRequestPrompts` does across an unmount+remount: the
      // same still-pending row comes back through the snapshot and gets
      // re-`add()`-ed under the SAME id. A mocked toast.add's call log
      // can't tell an upsert from a duplicate render — only the real
      // manager + a real `<Toaster/>` can prove there's still one prompt.
      add(pairingOptions())

      expect(screen.getAllByText('Verification code: CCCC-3333')).toHaveLength(
        1
      )
      expect(screen.getAllByRole('alertdialog', { hidden: true })).toHaveLength(
        1
      )
    })
  })
})
