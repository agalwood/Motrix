import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FontCombobox } from './font-combobox'

const mockFonts = ['Arial', 'Courier New', 'Fira Code', 'Inter', 'Roboto']

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('<FontCombobox>', () => {
  beforeEach(async () => {
    window.ResizeObserver =
      MockResizeObserver as unknown as typeof ResizeObserver
    window.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof IntersectionObserver
    window.HTMLElement.prototype.scrollIntoView = vi.fn()

    // Floating UI requires non-zero element dimensions in JSDOM
    Element.prototype.getBoundingClientRect = vi.fn(() => ({
      width: 200,
      height: 32,
      top: 0,
      left: 0,
      bottom: 32,
      right: 200,
      x: 0,
      y: 0,
      toJSON: () => {},
    }))
  })

  it('renders input with value and provided placeholder', () => {
    render(
      <FontCombobox
        value="Inter"
        onChange={vi.fn()}
        systemFonts={mockFonts}
        isLoading={false}
        placeholder="Custom placeholder"
      />
    )
    expect(screen.getByRole('combobox')).toHaveValue('Inter')
    expect(
      screen.getByPlaceholderText('Custom placeholder')
    ).toBeInTheDocument()
  })

  it('displays loading spinner when isLoading is true', () => {
    const { container } = render(
      <FontCombobox
        value=""
        onChange={vi.fn()}
        systemFonts={mockFonts}
        isLoading={true}
      />
    )
    expect(container.querySelector('.animate-spin')).toBeInTheDocument()
  })

  it('filters fonts list when user types', async () => {
    const user = userEvent.setup()
    render(
      <FontCombobox
        value="fir"
        onChange={vi.fn()}
        systemFonts={mockFonts}
        isLoading={false}
      />
    )

    const input = screen.getByRole('combobox')
    await user.click(input)

    expect(
      screen.getByRole('option', { name: 'Fira Code' })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('option', { name: 'Arial' })
    ).not.toBeInTheDocument()
  })

  it('selects a font on option click and closes dropdown', async () => {
    const handleChange = vi.fn()
    const user = userEvent.setup()
    render(
      <FontCombobox
        value=""
        onChange={handleChange}
        systemFonts={mockFonts}
        isLoading={false}
      />
    )

    const input = screen.getByRole('combobox')
    await user.click(input)

    const option = screen.getByRole('option', { name: 'Roboto' })
    await user.click(option)

    expect(handleChange).toHaveBeenCalledWith('Roboto')
    expect(
      screen.queryByRole('option', { name: 'Roboto' })
    ).not.toBeInTheDocument()
  })

  it('navigates list with arrow keys and selects option with Enter', async () => {
    const handleChange = vi.fn()
    const user = userEvent.setup()
    render(
      <FontCombobox
        value=""
        onChange={handleChange}
        systemFonts={['Arial', 'Roboto']}
        isLoading={false}
      />
    )

    const input = screen.getByRole('combobox')
    await user.click(input)

    await user.keyboard('{ArrowDown}')
    await user.keyboard('{ArrowDown}')
    await user.keyboard('{Enter}')

    expect(handleChange).toHaveBeenCalledWith('Roboto')
    expect(
      screen.queryByRole('option', { name: 'Roboto' })
    ).not.toBeInTheDocument()
  })

  it('closes dropdown on Escape key press', async () => {
    const user = userEvent.setup()
    render(
      <FontCombobox
        value=""
        onChange={vi.fn()}
        systemFonts={mockFonts}
        isLoading={false}
      />
    )

    const input = screen.getByRole('combobox')
    await user.click(input)
    expect(screen.getByRole('option', { name: 'Arial' })).toBeInTheDocument()

    await user.keyboard('{Escape}')
    expect(
      screen.queryByRole('option', { name: 'Arial' })
    ).not.toBeInTheDocument()
  })

  it('closes dropdown when clicking outside', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <div data-testid="outside">Outside</div>
        <FontCombobox
          value=""
          onChange={vi.fn()}
          systemFonts={mockFonts}
          isLoading={false}
        />
      </div>
    )

    const input = screen.getByRole('combobox')
    await user.click(input)
    expect(screen.getByRole('option', { name: 'Arial' })).toBeInTheDocument()

    await user.click(screen.getByTestId('outside'))
    expect(
      screen.queryByRole('option', { name: 'Arial' })
    ).not.toBeInTheDocument()
  })
})
