import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  nativeImage: { createFromBuffer: vi.fn() },
}))

vi.mock('./tray-icon', async () => {
  const actual = await vi.importActual('./tray-icon')
  return { ...actual }
})

import { buildSpeedometerSvg } from './tray-speedometer'

const MOCK_ICON_SVG = '<rect width="32" height="32" fill="black"/>'

describe('buildSpeedometerSvg', () => {
  it('produces valid SVG with speed text', () => {
    const svg = buildSpeedometerSvg(MOCK_ICON_SVG, 1024, 1048576)
    expect(svg).toContain('<svg')
    expect(svg).toContain('1 KB/s')
    expect(svg).toContain('1.0 MB/s')
  })

  it('shows zero speeds', () => {
    const svg = buildSpeedometerSvg(MOCK_ICON_SVG, 0, 0)
    expect(svg).toContain('0 KB/s')
  })

  it('embeds icon SVG content', () => {
    const svg = buildSpeedometerSvg(MOCK_ICON_SVG, 0, 0)
    expect(svg).toContain(MOCK_ICON_SVG)
  })
})
