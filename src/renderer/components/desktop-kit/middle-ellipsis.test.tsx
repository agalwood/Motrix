import '@testing-library/jest-dom/vitest'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MiddleEllipsis } from './middle-ellipsis'

describe('MiddleEllipsis', () => {
  it.each([
    '',
    'ffmpeg',
    '/Users/example/Library/Application Support/Motrix/binaries/ffmpeg-verified/releases/hash-darwin-arm64/ffmpeg',
    'C:\\Users\\example\\AppData\\Roaming\\Motrix\\binaries\\ffmpeg.exe',
    '\\\\server\\share\\工具\\ffmpeg.exe',
    '/data/👩‍💻/e\u0301/ffmpeg',
  ])('keeps full accessible and tooltip text for %s', (text) => {
    const { container } = render(<MiddleEllipsis text={text} />)
    const root = container.querySelector('[data-slot="middle-ellipsis"]')
    expect(root).toHaveAttribute('title', text)
    expect(root).toHaveAttribute('dir', 'ltr')
    expect(root?.querySelector('.sr-only')?.textContent).toBe(text)
    const fragments = root?.querySelectorAll(':scope > [aria-hidden="true"]')
    expect(fragments).toHaveLength(2)
    expect(
      Array.from(fragments ?? [], (fragment) => fragment.textContent).join('')
    ).toBe(text)
    expect(fragments?.[0]).toHaveClass('truncate')
    expect(fragments?.[1]).toHaveClass('justify-end', 'overflow-hidden')
  })

  it('does not split a Unicode grapheme between the two fragments', () => {
    const { container } = render(<MiddleEllipsis text="a👩‍💻b" />)
    const fragments = container.querySelectorAll(
      '[data-slot="middle-ellipsis"] > [aria-hidden="true"]'
    )
    expect(fragments[0]).toHaveTextContent('a👩‍💻')
    expect(fragments[1]).toHaveTextContent('b')
  })
})
