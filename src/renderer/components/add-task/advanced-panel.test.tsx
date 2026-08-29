import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FormProvider, useForm } from 'react-hook-form'
import { describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { AddTaskLayoutProvider } from './add-task-layout-context'
import { AdvancedPanel } from './advanced-panel'

function Wrapper({
  tab,
  onAdvancedOpenChange,
}: {
  tab: 'links' | 'torrent'
  onAdvancedOpenChange?: (expanded: boolean) => void
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
      </FormProvider>
    </AddTaskLayoutProvider>
  )
}

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
