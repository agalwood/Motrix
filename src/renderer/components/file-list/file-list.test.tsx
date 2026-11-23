import '@test-utils/dom-animations'
import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import type { TorrentFileInfo } from '@shared/types/torrent'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { useState } from 'react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { FileList } from './file-list'

// Make the virtualizer think the scroll container is 600px tall so all
// rows (32px each) are within the visible window and actually rendered.
beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return {
        top: 0,
        left: 0,
        bottom: 600,
        right: 800,
        width: 800,
        height: this.classList.contains('sticky') ? 64 : 600,
      }
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      return 600
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return 600
    },
  })
})

const makeFiles = (): TorrentFileInfo[] => [
  { index: 0, path: 'movie.mp4', size: 1_500_000_000, extension: '.mp4' },
  { index: 1, path: 'track.mp3', size: 10_000_000, extension: '.mp3' },
  { index: 2, path: 'photo.jpg', size: 500_000, extension: '.jpg' },
  { index: 3, path: 'readme.txt', size: 2_000, extension: '.txt' },
  { index: 4, path: 'subtitle.srt', size: 50_000, extension: '.srt' },
]

describe('FileList', () => {
  const nested = [
    { index: 12, path: 'Film/movie.mkv', size: 100 },
    { index: 7, path: 'Film/subs/en.srt', size: 10 },
    { index: 42, path: 'notes.txt', size: 5 },
    { index: 2, path: '.pad/0', size: 100, padding: true },
  ]

  function ControlledTree() {
    const [selected, setSelected] = useState([42])
    return (
      <FileList
        files={nested}
        selectedIndices={selected}
        onSelectionChange={setSelected}
      />
    )
  }

  it('selects folders with original indices, reports mixed state and excludes padding', () => {
    const changed = vi.fn()
    render(
      <FileList
        files={nested}
        selectedIndices={[7]}
        onSelectionChange={changed}
      />
    )
    expect(screen.queryByTitle('.pad/0')).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Film' })).toHaveAttribute(
      'aria-checked',
      'mixed'
    )
    fireEvent.click(screen.getByRole('checkbox', { name: 'Film' }))
    expect(changed).toHaveBeenCalledWith([7, 12])
  })

  it('searches paths, expands matching ancestors and selects only matching files', async () => {
    render(<ControlledTree />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    expect(screen.queryByTitle('Film/subs/en.srt')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: '.srt' },
    })
    await screen.findByTitle('Film/subs/en.srt')
    expect(screen.queryByTitle('Film/movie.mkv')).not.toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select matching files' })
    )
    expect(screen.getByText(/2 files selected/)).toHaveTextContent('15 B')
    expect(screen.getByRole('checkbox', { name: 'Film' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    await screen.findByRole('checkbox', { name: 'Select all' })
    expect(screen.getByRole('checkbox', { name: 'notes.txt' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.queryByTitle('Film/subs/en.srt')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'absent' },
    })
    expect(await screen.findByText('No matching files')).toBeInTheDocument()
  })

  it('supports keyboard expansion, navigation and folder selection in the virtual tree', () => {
    render(<ControlledTree />)
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
    const tree = screen.getByRole('tree')
    tree.focus()
    fireEvent.keyDown(tree, { key: 'ArrowRight' })
    expect(screen.getByTitle('Film/movie.mkv')).toBeInTheDocument()
    fireEvent.keyDown(tree, { key: ' ' })
    expect(screen.getByText(/3 files selected/)).toBeInTheDocument()
    fireEvent.keyDown(tree, { key: 'End' })
    expect(
      document.getElementById(tree.getAttribute('aria-activedescendant')!)
    ).toHaveAttribute('aria-label', 'notes.txt')
    fireEvent.keyDown(tree, { key: ' ' })
    expect(screen.getByText(/2 files selected/)).toBeInTheDocument()
    const row = screen.getByRole('treeitem', { name: 'notes.txt' })
    row.focus()
    fireEvent.keyDown(row, { key: 'Home' })
    expect(tree).toHaveFocus()
    expect(
      document.getElementById(tree.getAttribute('aria-activedescendant')!)
    ).toHaveAttribute('aria-label', 'Film')
  })

  it('keeps search Enter from submitting New Task and consumes Escape to clear the filter', () => {
    const parentKeyDown = vi.fn()
    render(
      <form onKeyDown={parentKeyDown}>
        <ControlledTree />
      </form>
    )
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: '.srt' } })
    expect(fireEvent.keyDown(search, { key: 'Enter' })).toBe(false)
    parentKeyDown.mockClear()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(search).toHaveValue('')
    expect(parentKeyDown).not.toHaveBeenCalled()
  })

  it('keeps expansion across progress snapshots and presents committed rename paths', async () => {
    const rows = nested.map((file) => ({ ...file, progress: 0 }))
    const props = {
      selectedIndices: [7],
      renderRowTrailing: (file: (typeof rows)[number]) => `${file.progress}%`,
    }
    const view = render(<FileList files={rows} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Film/subs' }))
    view.rerender(
      <FileList
        files={rows.map((file) => ({ ...file, progress: 50 }))}
        {...props}
      />
    )
    expect(screen.queryByTitle('Film/subs/en.srt')).not.toBeInTheDocument()
    expect(screen.getAllByText('50%')).toHaveLength(2)
    view.rerender(
      <FileList
        files={rows.map((file) =>
          file.index === 12 ? { ...file, path: 'Film/renamed.mkv' } : file
        )}
        {...props}
      />
    )
    expect(await screen.findByTitle('Film/renamed.mkv')).toBeInTheDocument()
    expect(screen.queryByTitle('Film/movie.mkv')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Film/subs/en.srt')).not.toBeInTheDocument()
  })

  it('keeps a large manifest virtual and cancels superseded background builds', async () => {
    const files = Array.from({ length: 10_000 }, (_, index) => ({
      index,
      path: `folder/${index}.bin`,
      size: 1,
    }))
    const view = render(
      <FileList files={files} selectedIndices={[]} readOnly />
    )
    await waitFor(() =>
      expect(screen.getByRole('tree')).toHaveAttribute('aria-busy', 'false')
    )
    expect(screen.getAllByRole('treeitem')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
    expect(screen.getAllByRole('treeitem').length).toBeLessThan(30)
    view.rerender(
      <FileList
        files={files.map((file) => ({ ...file, path: `new/${file.path}` }))}
        selectedIndices={[]}
        readOnly
      />
    )
    view.rerender(
      <FileList
        files={[{ index: 88, path: 'replacement.bin', size: 8 }]}
        selectedIndices={[]}
        readOnly
      />
    )
    expect(await screen.findByTitle('replacement.bin')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByRole('tree')).toHaveAttribute('aria-busy', 'false')
    )
    expect(screen.queryByTitle('new')).not.toBeInTheDocument()
    expect(screen.getAllByRole('treeitem')).toHaveLength(1)
  })

  it('can hide column headers while keeping file types and selection controls', () => {
    const onSelectionChange = vi.fn()
    render(
      <FileList
        files={makeFiles()}
        selectedIndices={[0]}
        onSelectionChange={onSelectionChange}
        showColumnHeaders={false}
        headerSlot={<button type="button">Video</button>}
      />
    )

    for (const label of ['File name', 'File type', 'Size']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument()
    }
    expect(screen.getByText('mp4')).toBeInTheDocument()
    expect(screen.getByText(/1 file selected/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Video' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }))
    expect(onSelectionChange).toHaveBeenCalledWith([0, 1, 2, 3, 4])
  })

  it('shows file types from file names without requiring torrent metadata', () => {
    const cases = [
      ['folder/movie.MP4', 'mp4'],
      ['archive.tar.gz', 'gz'],
      ['C:\\folder\\photo.JPG', 'jpg'],
      ['folder.v1/README', '—'],
      ['folder.v1\\LICENSE', '—'],
      ['.gitignore', '—'],
      ['.env.local', 'local'],
      ['trailing.', '—'],
    ]
    render(
      <FileList
        files={cases.map(([path], index) => ({ index, path, size: 10 }))}
        selectedIndices={[]}
        readOnly
      />
    )

    expect(screen.getByText('File type')).toBeInTheDocument()
    for (const [path, extension] of cases) {
      const row = screen.getByRole('checkbox', { name: path }).parentElement!
      expect(within(row).getByTitle(extension)).toHaveTextContent(extension)
    }
  })

  it('renders all file names', () => {
    render(
      <FileList<TorrentFileInfo>
        files={makeFiles()}
        selectedIndices={[]}
        onSelectionChange={vi.fn()}
      />
    )
    expect(screen.getByText('movie.mp4')).toBeDefined()
    expect(screen.getByText('track.mp3')).toBeDefined()
    expect(screen.getByText('photo.jpg')).toBeDefined()
    expect(screen.getByText('readme.txt')).toBeDefined()
    expect(screen.getByText('subtitle.srt')).toBeDefined()
  })

  it('preserves bracketed file-name display order', () => {
    const path = '[aa1][bb2] cc3.ext'
    render(
      <FileList<TorrentFileInfo>
        files={[{ index: 0, path, size: 1, extension: '.ext' }]}
        selectedIndices={[]}
        onSelectionChange={vi.fn()}
      />
    )

    const fileName = screen.getByTitle(path)
    expect(fileName).toHaveAttribute('dir', 'auto')
    expect(fileName).not.toHaveClass('[direction:rtl]')
  })

  it('calls onSelectionChange when toggling a file off', () => {
    const onSelectionChange = vi.fn()
    render(
      <FileList<TorrentFileInfo>
        files={makeFiles()}
        selectedIndices={[0, 1, 2]}
        onSelectionChange={onSelectionChange}
      />
    )
    // First checkbox is select-all, then file checkboxes in order
    const checkboxes = screen.getAllByRole('checkbox')
    // checkboxes[0] = select-all, [1] = file index 0, [2] = file index 1
    fireEvent.click(checkboxes[2]) // toggle off file index 1
    expect(onSelectionChange).toHaveBeenCalledWith([0, 2])
  })

  it('calls onSelectionChange when toggling a file on', () => {
    const onSelectionChange = vi.fn()
    render(
      <FileList<TorrentFileInfo>
        files={makeFiles()}
        selectedIndices={[0]}
        onSelectionChange={onSelectionChange}
      />
    )
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[2]) // toggle on file index 1
    expect(onSelectionChange).toHaveBeenCalledWith([0, 1])
  })

  it('displays selected count text for multiple files', () => {
    render(
      <FileList<TorrentFileInfo>
        files={makeFiles()}
        selectedIndices={[0, 1]}
        onSelectionChange={vi.fn()}
      />
    )
    expect(screen.getByText(/2 files selected/i)).toBeDefined()
  })

  it('displays selected count as 1 file when only one selected', () => {
    render(
      <FileList<TorrentFileInfo>
        files={makeFiles()}
        selectedIndices={[0]}
        onSelectionChange={vi.fn()}
      />
    )
    expect(screen.getByText(/1 file selected/i)).toBeDefined()
  })

  it('select-all selects all files when none selected', () => {
    const onSelectionChange = vi.fn()
    render(
      <FileList<TorrentFileInfo>
        files={makeFiles()}
        selectedIndices={[]}
        onSelectionChange={onSelectionChange}
      />
    )
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0]) // select-all
    expect(onSelectionChange).toHaveBeenCalledWith([0, 1, 2, 3, 4])
  })

  it('select-all deselects all files when all selected', () => {
    const onSelectionChange = vi.fn()
    render(
      <FileList<TorrentFileInfo>
        files={makeFiles()}
        selectedIndices={[0, 1, 2, 3, 4]}
        onSelectionChange={onSelectionChange}
      />
    )
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0]) // select-all
    expect(onSelectionChange).toHaveBeenCalledWith([])
  })

  it('formats file sizes correctly', () => {
    const files: TorrentFileInfo[] = [
      { index: 0, path: 'big.mkv', size: 1_073_741_824, extension: '.mkv' }, // 1.07 GB
      { index: 1, path: 'mid.mp3', size: 5_242_880, extension: '.mp3' }, // 5.24 MB
      { index: 2, path: 'small.txt', size: 1_024, extension: '.txt' }, // 1.02 KB
    ]
    render(
      <FileList<TorrentFileInfo>
        files={files}
        selectedIndices={[]}
        onSelectionChange={vi.fn()}
      />
    )
    expect(screen.getByText('1.07 GB')).toBeDefined()
    expect(screen.getByText('5.24 MB')).toBeDefined()
    expect(screen.getByText('1.02 KB')).toBeDefined()
  })

  it('disables checkboxes in readOnly mode', () => {
    render(
      <FileList<TorrentFileInfo>
        files={makeFiles()}
        selectedIndices={[0]}
        onSelectionChange={vi.fn()}
        readOnly
      />
    )
    for (const cb of screen.getAllByRole('checkbox')) {
      expect(cb).toHaveAttribute('aria-disabled', 'true')
    }
  })

  it('hides select-all checkbox in readOnly mode', () => {
    render(
      <FileList<TorrentFileInfo>
        files={makeFiles()}
        selectedIndices={[]}
        readOnly
      />
    )
    // Only file checkboxes should render, not the select-all
    expect(screen.getAllByRole('checkbox')).toHaveLength(makeFiles().length)
  })

  it('renders renderRowTrailing slot', () => {
    const files = makeFiles()
    render(
      <FileList<TorrentFileInfo>
        files={files}
        selectedIndices={[]}
        onSelectionChange={vi.fn()}
        renderRowTrailing={(f) => (
          <span data-testid={`trailing-${f.index}`}>!</span>
        )}
      />
    )
    for (const f of files) {
      expect(screen.getByTestId(`trailing-${f.index}`)).toBeInTheDocument()
    }
  })
})
