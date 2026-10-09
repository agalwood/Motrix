import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './tooltip'

describe('Tooltip', () => {
  it('opens on keyboard focus and dismisses with Escape', async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Trigger</TooltipTrigger>
          <TooltipContent>Details</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )

    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    await user.tab()
    const trigger = screen.getByRole('button', { name: 'Trigger' })
    expect(trigger).toHaveFocus()
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Details')

    await user.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    )
    expect(trigger).toHaveFocus()
  })
})
