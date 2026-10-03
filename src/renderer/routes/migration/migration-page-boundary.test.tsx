import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { MigrationPage } from './migration-page'

vi.mock('@renderer/features/legacy-import/legacy-import-dialog', () => ({
  LegacyImportDialog: () => {
    throw new Error('Unexpected rendering failure')
  },
}))

function Host() {
  const location = useLocation()
  const active = location.pathname === '/migration'
  return (
    <>
      <p>Other navigation remains available</p>
      <div hidden={!active}>
        <MigrationPage active={active} />
      </div>
      {!active && <p>DOWNLOADS_PAGE</p>}
    </>
  )
}

describe('migration failure isolation', () => {
  it('keeps unrelated navigation usable without automatically starting another import', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(
        <MemoryRouter initialEntries={['/migration']}>
          <Host />
        </MemoryRouter>
      )
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Migration couldn’t open.'
      )
      expect(
        screen.getByText('Other navigation remains available')
      ).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: 'View downloads' }))
      expect(screen.getByText('DOWNLOADS_PAGE')).toBeVisible()
    } finally {
      log.mockRestore()
    }
  })
})
