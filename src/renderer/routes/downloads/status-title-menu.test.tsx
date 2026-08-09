import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { StatusTitleMenu } from './status-title-menu'

beforeAll(() => {
  // jsdom lacks these; Radix dropdown touches them on open.
  Element.prototype.scrollIntoView = vi.fn()
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false
  }
})

const counts = { all: 12, active: 4, completed: 7, error: 1 }

describe('StatusTitleMenu', () => {
  it('renders the current status in the heading', () => {
    render(
      <StatusTitleMenu tab="active" onTabChange={vi.fn()} counts={counts} />
    )
    const heading = screen.getByRole('heading')
    expect(heading).toHaveTextContent(/active/i)
    expect(heading).toHaveTextContent(/downloads/i)
  })

  it('shows the inline count', () => {
    render(
      <StatusTitleMenu tab="active" onTabChange={vi.fn()} counts={counts} />
    )
    // Inline badge renders `${counts[tab]}/${counts.all}` → active 4 of 12.
    expect(screen.getByText('4/12')).toBeInTheDocument()
  })

  // The trigger carries the `app-no-drag` utility (-webkit-app-region: no-drag)
  // so it stays clickable inside the Electron frameless-window drag region.
  // jsdom does not implement the non-standard `-webkit-app-region` property, so
  // the region behavior can't be asserted here — it's covered by the manual
  // Electron smoke check in the plan's final task.

  it('selecting a menu item calls onTabChange', async () => {
    const onTabChange = vi.fn()
    const user = userEvent.setup()
    render(
      <StatusTitleMenu tab="all" onTabChange={onTabChange} counts={counts} />
    )
    await user.click(screen.getByRole('button', { name: /downloads/i }))
    await user.click(
      await screen.findByRole('menuitem', { name: /completed/i })
    )
    expect(onTabChange).toHaveBeenCalledWith('completed')
  })

  it('positions the trigger for window-chrome stacking', () => {
    render(<StatusTitleMenu tab="all" onTabChange={vi.fn()} counts={counts} />)
    const trigger = screen.getByRole('button', { name: /downloads/i })
    // `relative` gives the trigger its own stacking context so it can be
    // z-layered against the fixed WindowChrome drag strip (the exact z is
    // tuned in the component). The app-region itself isn't observable in jsdom.
    expect(trigger).toHaveClass('relative')
  })
})
