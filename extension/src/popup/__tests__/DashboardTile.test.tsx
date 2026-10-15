import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Activity } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'

import { DashboardTile } from '@/popup/DashboardTile'
import { SpeedTile } from '@/popup/SpeedTile'

describe('DashboardTile', () => {
  it('keeps a minimum tile height and shares rows for aligned values', () => {
    render(<DashboardTile label="Activity" value={3} />)

    const tile = screen.getByRole('group', { name: 'Activity' })
    const valueRow = tile.querySelector(
      '[data-slot="dashboard-tile-value-row"]'
    )
    const value = tile.querySelector('[data-slot="dashboard-tile-value"]')

    expect(tile.className).toContain('min-h-20')
    expect(tile.className).toContain('grid-rows-subgrid')
    expect(tile.className).toContain('rounded-[10px]')
    expect(valueRow?.className).not.toContain('absolute')
    expect(valueRow?.className).toContain('items-baseline')
    expect(valueRow?.className).toContain('gap-0.5')
    expect(value?.className).toContain('text-[20px]')
    expect(value?.className).toContain('leading-none')
    expect(value?.className).toContain('font-semibold')
    expect(value?.className).toContain('tracking-[-0.01em]')
  })

  it('becomes an accessible clickable metric tile when given an action', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <DashboardTile
        label="Resources"
        value="6"
        icon={Activity}
        iconClassName="text-speed-download"
        ariaLabel="View page resources"
        onClick={onClick}
      />
    )

    const tile = screen.getByRole('button', { name: 'View page resources' })
    expect(tile.querySelector('[data-slot="dashboard-tile-icon"]')).toBeTruthy()
    expect(tile.querySelector('[data-slot="dashboard-tile-unit"]')).toBeNull()

    await user.click(tile)
    expect(onClick).toHaveBeenCalledOnce()
  })
})

describe('SpeedTile', () => {
  it('keeps the value and compact unit on one baseline', () => {
    render(
      <SpeedTile
        kind="download"
        label="Download"
        bytesPerSecond={12.8 * 1024 * 1024}
      />
    )

    const tile = screen.getByRole('group', { name: 'Download' })
    const valueRow = tile.querySelector(
      '[data-slot="dashboard-tile-value-row"]'
    )
    const unit = within(tile).getByText('MB/s')

    expect(within(tile).getByText('12.8')).toBeTruthy()
    expect(unit.parentElement).toBe(valueRow)
    expect(unit.className).toContain('text-[8px]')
  })

  it('uses the compact Motrix download and upload graph bands', () => {
    render(
      <>
        <SpeedTile kind="upload" label="Upload" bytesPerSecond={256} />
        <SpeedTile kind="download" label="Download" bytesPerSecond={512} />
      </>
    )

    const upload = screen.getByRole('group', { name: 'Upload' })
    const download = screen.getByRole('group', { name: 'Download' })

    expect(upload.querySelector('.bottom-0')?.className).toContain('h-2')
    expect(upload.querySelector('.bottom-2')?.className).toContain('h-px')
    expect(download.querySelector('.bottom-0')?.className).toContain('h-2')
    expect(download.querySelector('.bottom-2')?.className).toContain('h-px')
  })
})
