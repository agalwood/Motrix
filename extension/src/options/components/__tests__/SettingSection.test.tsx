import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SettingSection } from '@/options/components/SettingSection'

describe('SettingSection', () => {
  it('renders an action node in the title row', () => {
    render(
      <SettingSection
        title="Backends"
        description="Pick one"
        action={<button type="button">Add server</button>}
      >
        <p>body</p>
      </SettingSection>
    )

    const heading = screen.getByRole('heading', { name: 'Backends' })
    const action = screen.getByRole('button', { name: 'Add server' })
    expect(heading).toBeTruthy()
    expect(screen.getByText('Pick one')).toBeTruthy()
    // The action shares the header row with the title, above the body.
    expect(
      action.compareDocumentPosition(screen.getByText('body')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('renders no header chrome when title and action are absent', () => {
    render(
      <SettingSection>
        <p>body only</p>
      </SettingSection>
    )
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.getByText('body only')).toBeTruthy()
  })
})
