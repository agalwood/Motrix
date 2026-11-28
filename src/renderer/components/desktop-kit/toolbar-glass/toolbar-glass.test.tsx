import '@testing-library/jest-dom/vitest'
import { transport } from '@renderer/lib/transport'
import { render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ToolbarGlass } from './toolbar-glass'

vi.mock('@renderer/lib/transport', () => ({
  transport: { platform: 'darwin' },
}))

afterEach(() => vi.unstubAllGlobals())

it.each([
  ['darwin', true, 1],
  ['darwin', false, 0],
  ['linux', true, 0],
  ['win32', true, 0],
  ['web', true, 0],
] as const)(
  'on %s with enabled=%s renders %i glass layers',
  (platform, enabled, count) => {
    Object.defineProperty(transport, 'platform', {
      configurable: true,
      value: platform,
    })
    vi.stubGlobal('CSS', { supports: () => false })
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }))
    const { container } = render(<ToolbarGlass enabled={enabled} />)
    expect(
      container.querySelectorAll('[data-slot="toolbar-glass"]')
    ).toHaveLength(count)
  }
)
