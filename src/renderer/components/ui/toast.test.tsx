import '@testing-library/jest-dom/vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
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
    expect(viewport).toHaveClass('end-4')
    expect(viewport).not.toHaveClass('right-4')
  })

  it.each(['win32', 'linux'] as const)(
    'positions %s toasts below the custom caption controls',
    async (platform) => {
      Object.defineProperty(window, 'motrix', {
        value: { ...window.motrix, platform },
        configurable: true,
      })
      try {
        const { baseElement } = render(<Toaster />)
        add({ title: 'safe area probe' })
        await screen.findByText('safe area probe')
        const viewport = baseElement.querySelector(
          '[aria-label="Notifications"]'
        ) as HTMLElement | null
        expect(viewport).toHaveStyle({ top: '56px' })
        expect(viewport).not.toHaveClass('top-4')
      } finally {
        Object.defineProperty(window, 'motrix', {
          value: { ...window.motrix, platform: 'darwin' },
          configurable: true,
        })
      }
    }
  )

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
        screen.getByRole('button', { name: 'Don’t allow', hidden: true })
      )
      expect(onDeny).toHaveBeenCalledOnce()
    })

    describe('extension pairing branch (§5 identity tri-state)', () => {
      function extensionPairRequest(
        overrides: Partial<{
          identity: 'official' | 'attested-non-official' | 'unverified'
          onDeny: () => void
        }> = {}
      ) {
        return {
          kind: 'extension' as const,
          pairingNonce: 'nonce',
          extensionId: 'ext-1',
          identity: overrides.identity ?? 'official',
          code: '1234-5678',
          browser: 'chromium' as const,
          onDeny: overrides.onDeny ?? vi.fn(),
        }
      }

      it('renders extension copy (title/browser) and the grouped pairing code, with no Allow button', async () => {
        render(<Toaster />)
        add({
          id: 'chromium:ext-official:nonce',
          timeout: 0,
          priority: 'high',
          data: {
            pairRequest: extensionPairRequest({ identity: 'official' }),
          },
        })

        expect(
          // MBP1 forbids displaying the self-reported extension name (§5),
          // and the raw id means nothing to a person in a title — it appears
          // exactly once, in the mono description line. The browser rides in
          // the title instead of a separate "From …" row.
          await screen.findByText(
            'A Chrome / Edge extension wants to connect to Motrix'
          )
        ).toBeInTheDocument()
        expect(screen.getByText('ID: ext-1')).toBeInTheDocument()
        expect(screen.queryByText('From Chrome / Edge')).toBeNull()
        // §7.1: rendered verbatim — already grouped XXXX-XXXX by the caller.
        expect(screen.getByText('1234-5678')).toBeInTheDocument()
        expect(
          screen.queryByRole('button', { name: 'Allow', hidden: true })
        ).not.toBeInTheDocument()
      })

      it('copies the display-form pairing code from the code box', async () => {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: vi.fn().mockResolvedValue(undefined) },
        })
        render(<Toaster />)
        add({
          id: 'chromium:ext-copy:nonce',
          timeout: 0,
          priority: 'high',
          data: {
            pairRequest: extensionPairRequest({ identity: 'official' }),
          },
        })

        await userEvent.click(
          await screen.findByRole('button', {
            name: 'Copy pairing code',
            hidden: true,
          })
        )
        await waitFor(() =>
          expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
            '1234-5678'
          )
        )
      })

      it('official: shows a Motrix-branded identity label and no warning styling', async () => {
        render(<Toaster />)
        add({
          id: 'chromium:ext-official-2:nonce',
          timeout: 0,
          priority: 'high',
          data: {
            pairRequest: extensionPairRequest({ identity: 'official' }),
          },
        })
        expect(
          await screen.findByText('Official Motrix extension')
        ).toBeInTheDocument()
        expect(screen.queryByText(/could not be verified/i)).toBeNull()
      })

      it('attested-non-official: shows a generic verified label with no Motrix branding and no warning', async () => {
        render(<Toaster />)
        add({
          id: 'chromium:ext-attested:nonce',
          timeout: 0,
          priority: 'high',
          data: {
            pairRequest: extensionPairRequest({
              identity: 'attested-non-official',
            }),
          },
        })
        const label = await screen.findByText('Verified extension')
        expect(label).toBeInTheDocument()
        expect(label.textContent).not.toMatch(/Motrix/)
        expect(screen.queryByText(/could not be verified/i)).toBeNull()
      })

      it('unverified: warning styling plus the raw claimed id — never a friendly name', async () => {
        const { baseElement } = render(<Toaster />)
        add({
          id: 'chromium:ext-unverified:nonce',
          timeout: 0,
          priority: 'high',
          data: {
            pairRequest: extensionPairRequest({ identity: 'unverified' }),
          },
        })

        expect(
          await screen.findByText('Unverified extension')
        ).toBeInTheDocument()
        expect(screen.getByText(/could not be verified/i)).toBeInTheDocument()
        expect(screen.getByText('ID: ext-1')).toBeInTheDocument()
        expect(screen.getByText('1234-5678')).toBeInTheDocument()
        expect(baseElement.querySelector('svg.text-amber-500')).not.toBeNull()
        // No self-reported friendly name exists in the payload at all, and
        // none is fabricated for display.
        expect(screen.queryByText('Motrix Extension')).toBeNull()
      })

      it('clicking "Don\'t allow" calls onDeny — the only decision affordance left for an extension prompt', async () => {
        render(<Toaster />)
        const onDeny = vi.fn()
        add({
          id: 'chromium:ext-deny:nonce',
          timeout: 0,
          priority: 'high',
          data: { pairRequest: extensionPairRequest({ onDeny }) },
        })
        await userEvent.click(
          screen.getByRole('button', { name: "Don't allow", hidden: true })
        )
        expect(onDeny).toHaveBeenCalledOnce()
      })
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
