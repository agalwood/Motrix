import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PopupTile } from '@/popup/PopupTile'

describe('PopupTile header geometry', () => {
  it('keeps the same centered 24px header with or without an action', () => {
    render(
      <>
        <PopupTile
          label="Tasks"
          action={<button type="button">Filters</button>}
        >
          <div>Task content</div>
        </PopupTile>
        <PopupTile label="Sniffer">
          <div>Sniffer content</div>
        </PopupTile>
      </>
    )

    const taskHeader = screen
      .getByRole('group', { name: 'Tasks' })
      .querySelector('[data-slot="card-header"]')
    const snifferHeader = screen
      .getByRole('group', { name: 'Sniffer' })
      .querySelector('[data-slot="card-header"]')

    expect(taskHeader).not.toBeNull()
    expect(snifferHeader).not.toBeNull()
    expect(taskHeader?.className).toContain('min-h-6')
    expect(taskHeader?.className).toContain('items-center')
    expect(taskHeader?.className).toContain('auto-rows-auto')
    expect(snifferHeader?.className).toContain('min-h-6')
    expect(snifferHeader?.className).toContain('items-center')
    expect(snifferHeader?.className).toContain('auto-rows-auto')
  })
})
