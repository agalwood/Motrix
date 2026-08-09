import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './tooltip'

describe('Tooltip', () => {
  it('positions its arrow for every supported side', async () => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>Trigger</TooltipTrigger>
          <TooltipContent>Details</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )

    const content = await screen.findByRole('tooltip')
    const arrow = content.querySelector('[aria-hidden="true"]')

    expect(arrow).toHaveClass(
      'data-[side=bottom]:top-1',
      'data-[side=inline-end]:top-1/2!',
      'data-[side=inline-start]:top-1/2!',
      'data-[side=left]:top-1/2!',
      'data-[side=right]:top-1/2!',
      'data-[side=top]:-bottom-2.5'
    )
  })
})
