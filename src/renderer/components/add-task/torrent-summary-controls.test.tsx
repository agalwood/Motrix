import '@renderer/lib/i18n'
import '@testing-library/jest-dom/vitest'
import type { AddTaskFormValues } from '@shared/schemas/add-task'
import type { TorrentMeta } from '@shared/types/torrent'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FormProvider, useForm } from 'react-hook-form'
import { describe, expect, it, vi } from 'vitest'
import { FileTypeFilters } from './file-type-filters'
import { TorrentInfoHeader } from './torrent-info-header'

const META: TorrentMeta = {
  name: 'Example bundle',
  infoHash: 'a'.repeat(40),
  totalSize: 1536,
  comment: null,
  isPrivate: false,
  files: [
    { index: 1, path: 'movie.MP4', size: 100, extension: '.MP4' },
    { index: 2, path: 'song.mp3', size: 100, extension: '.mp3' },
    { index: 3, path: 'notes.txt', size: 100, extension: '.txt' },
    { index: 4, path: 'archive.zip', size: 100, extension: '.zip' },
  ],
}

function TorrentControls({ onClear }: { onClear: () => void }) {
  const form = useForm<AddTaskFormValues>({
    defaultValues: {
      tab: 'torrent',
      source: 'file',
      base64: 'torrent-data',
      torrentMeta: META,
      selectedFiles: [4],
      saveDir: '/downloads',
    },
  })
  const selected = form.watch('selectedFiles')

  return (
    <FormProvider {...form}>
      <TorrentInfoHeader onClear={onClear} />
      <FileTypeFilters />
      <output data-testid="selected-files">{selected?.join(',')}</output>
    </FormProvider>
  )
}

describe('torrent summary controls', () => {
  it('shows torrent identity, formatted size, and clear action', async () => {
    const onClear = vi.fn()
    const user = userEvent.setup()
    render(<TorrentControls onClear={onClear} />)

    expect(screen.getByTitle('Example bundle')).toBeInTheDocument()
    expect(screen.getByText('1.5 KB')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear selection' }))
    expect(onClear).toHaveBeenCalledOnce()
  })

  it('adds matching file types without dropping or duplicating selections', async () => {
    const user = userEvent.setup()
    render(<TorrentControls onClear={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Video' }))
    await user.click(screen.getByRole('button', { name: 'Video' }))
    await user.click(screen.getByRole('button', { name: 'Audio' }))
    await user.click(screen.getByRole('button', { name: 'Document' }))

    expect(screen.getByTestId('selected-files')).toHaveTextContent('4,1,2,3')
  })

  it('shows a tooltip for each file type filter', async () => {
    const user = userEvent.setup()
    render(<TorrentControls onClear={vi.fn()} />)

    for (const label of ['Video', 'Audio', 'Image', 'Document']) {
      await user.hover(screen.getByRole('button', { name: label }))
      expect(await screen.findByRole('tooltip')).toHaveTextContent(label)
      await user.unhover(screen.getByRole('button', { name: label }))
    }
  })
})
