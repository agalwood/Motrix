import { setByteUnitSystem } from '@renderer/hooks/use-byte-format'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FormProvider, useForm } from 'react-hook-form'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { AddTaskLayoutProvider } from './add-task-layout-context'
import { AdvancedPanel } from './advanced-panel'

function Wrapper({
  tab,
  onAdvancedOpenChange,
  onSubmit,
}: {
  tab: 'links' | 'torrent'
  onAdvancedOpenChange?: (expanded: boolean) => void
  onSubmit?: (values: unknown) => void
}) {
  const form = useForm({
    defaultValues:
      tab === 'links'
        ? { tab: 'links', urls: '', saveDir: '/d' }
        : {
            tab: 'torrent',
            source: 'magnet',
            magnetUri: 'magnet:?xt=x',
            torrentMeta: {
              name: 't',
              infoHash: 'a'.repeat(40),
              totalSize: 0,
              files: [],
            },
            selectedFiles: [0],
            saveDir: '/d',
          },
  })
  return (
    <AddTaskLayoutProvider onAdvancedOpenChange={onAdvancedOpenChange}>
      <FormProvider {...form}>
        <AdvancedPanel />
        {onSubmit && (
          <button type="button" onClick={() => onSubmit(form.getValues())}>
            Submit
          </button>
        )}
      </FormProvider>
    </AddTaskLayoutProvider>
  )
}

afterEach(() => {
  cleanup()
  setByteUnitSystem('decimal')
})

describe('AdvancedPanel', () => {
  it('renders Links-flavored fields when tab=links', async () => {
    const user = userEvent.setup()
    render(<Wrapper tab="links" />)
    await user.click(screen.getByRole('button', { name: /advanced/i }))
    expect(screen.getByLabelText(/filename/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/user-agent/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/connections/i)).toHaveValue(null)
  })

  it('renders Torrent-flavored fields when tab=torrent', async () => {
    const user = userEvent.setup()
    render(<Wrapper tab="torrent" />)
    await user.click(screen.getByRole('button', { name: /advanced/i }))
    expect(screen.getByLabelText(/dl limit/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/seed ratio/i)).toBeInTheDocument()
  })

  it('reports both expansion and collapse after layout commits', async () => {
    const user = userEvent.setup()
    const onAdvancedOpenChange = vi.fn()
    render(<Wrapper tab="links" onAdvancedOpenChange={onAdvancedOpenChange} />)
    expect(onAdvancedOpenChange).toHaveBeenLastCalledWith(false)

    const trigger = screen.getByRole('button', { name: /advanced/i })
    await user.click(trigger)
    expect(onAdvancedOpenChange).toHaveBeenLastCalledWith(true)

    await user.click(trigger)
    expect(onAdvancedOpenChange).toHaveBeenLastCalledWith(false)
  })
})

it.each(['decimal', 'binary'] as const)(
  'submits %s torrent limits in bytes per second and preserves them across unit changes',
  async (unitSystem) => {
    setByteUnitSystem(unitSystem)
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<Wrapper tab="torrent" onSubmit={onSubmit} />)
    await user.click(screen.getByRole('button', { name: /advanced/i }))
    const input = screen.getByLabelText(/dl limit/i)
    fireEvent.change(input, { target: { value: '1000' } })
    act(() =>
      setByteUnitSystem(unitSystem === 'decimal' ? 'binary' : 'decimal')
    )
    await user.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        dlLimit: unitSystem === 'decimal' ? 1_000_000 : 1_024_000,
      })
    )
  }
)

it.each(['decimal', 'binary'] as const)(
  'allows fractional %s torrent limits without disrupting typing',
  async (unitSystem) => {
    setByteUnitSystem(unitSystem)
    const onSubmit = vi.fn()
    const user = userEvent.setup()
    render(<Wrapper tab="torrent" onSubmit={onSubmit} />)
    await user.click(screen.getByRole('button', { name: /advanced/i }))
    const input = screen.getByLabelText(/dl limit/i)
    await user.clear(input)
    await user.type(input, '1.1')
    expect(input).toHaveValue(1.1)
    await user.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        dlLimit: unitSystem === 'binary' ? 1126 : 1100,
      })
    )
  }
)
