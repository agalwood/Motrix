import '@testing-library/jest-dom/vitest'
import '@renderer/lib/i18n'
import type { TorrentFileInfo } from '@shared/types/torrent'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { FileList } from './file-list'

// Make the virtualizer think the scroll container is 600px tall so all
// rows (32px each) are within the visible window and actually rendered.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return {
        top: 0,
        left: 0,
        bottom: 600,
        right: 800,
        width: 800,
        height: 600,
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

    const fileName = screen.getByText(path)
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
      { index: 0, path: 'big.mkv', size: 1_073_741_824, extension: '.mkv' }, // 1.0 GB
      { index: 1, path: 'mid.mp3', size: 5_242_880, extension: '.mp3' }, // 5.0 MB
      { index: 2, path: 'small.txt', size: 1_024, extension: '.txt' }, // 1.0 KB
    ]
    render(
      <FileList<TorrentFileInfo>
        files={files}
        selectedIndices={[]}
        onSelectionChange={vi.fn()}
      />
    )
    expect(screen.getByText('1.0 GB')).toBeDefined()
    expect(screen.getByText('5.0 MB')).toBeDefined()
    expect(screen.getByText('1.0 KB')).toBeDefined()
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
