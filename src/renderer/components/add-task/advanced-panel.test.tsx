import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FormProvider, useForm } from 'react-hook-form'
import { describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import { AdvancedPanel } from './advanced-panel'

function Wrapper({ tab }: { tab: 'links' | 'torrent' }) {
  const form = useForm({
    defaultValues:
      tab === 'links'
        ? { tab: 'links', urls: '', saveDir: '/d', split: 5 }
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
    <FormProvider {...form}>
      <AdvancedPanel />
    </FormProvider>
  )
}

describe('AdvancedPanel', () => {
  it('renders Links-flavored fields when tab=links', async () => {
    const user = userEvent.setup()
    render(<Wrapper tab="links" />)
    await user.click(screen.getByRole('button', { name: /advanced/i }))
    expect(screen.getByLabelText(/filename/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/user-agent/i)).toBeInTheDocument()
  })

  it('renders Torrent-flavored fields when tab=torrent', async () => {
    const user = userEvent.setup()
    render(<Wrapper tab="torrent" />)
    await user.click(screen.getByRole('button', { name: /advanced/i }))
    expect(screen.getByLabelText(/dl limit/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/seed ratio/i)).toBeInTheDocument()
  })
})
