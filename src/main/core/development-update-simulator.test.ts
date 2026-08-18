import { describe, expect, it, vi } from 'vitest'
import {
  DevelopmentUpdateSimulator,
  shouldUseDevelopmentUpdateSimulator,
} from './development-update-simulator'

describe('DevelopmentUpdateSimulator', () => {
  it('is gated to explicitly enabled unpackaged runs', () => {
    expect(
      shouldUseDevelopmentUpdateSimulator({ isPackaged: false, value: '1' })
    ).toBe(true)
    expect(
      shouldUseDevelopmentUpdateSimulator({ isPackaged: false, value: 'true' })
    ).toBe(false)
    expect(
      shouldUseDevelopmentUpdateSimulator({ isPackaged: true, value: '1' })
    ).toBe(false)
  })

  it('emits a stable update followed by determinate download progress', async () => {
    const simulator = createSimulator()
    const checking = vi.fn()
    const available = vi.fn()
    const progress = vi.fn()
    const downloaded = vi.fn()
    simulator.on('checking-for-update', checking)
    simulator.on('update-available', available)
    simulator.on('download-progress', progress)
    simulator.on('update-downloaded', downloaded)

    await simulator.checkForUpdates()
    await simulator.downloadUpdate()

    expect(checking).toHaveBeenCalledOnce()
    expect(available).toHaveBeenCalledWith({
      version: '2.0.1',
      releaseName: 'Development update simulator',
    })
    expect(progress.mock.calls.map(([value]) => value.percent)).toEqual([
      8, 24, 47, 72, 91, 100,
    ])
    expect(downloaded).toHaveBeenCalledWith({
      version: '2.0.1',
      releaseName: 'Development update simulator',
    })
  })

  it('uses a beta version when the beta channel is selected', async () => {
    const simulator = createSimulator()
    const available = vi.fn()
    simulator.channel = 'beta'
    simulator.on('update-available', available)

    await simulator.checkForUpdates()

    expect(available).toHaveBeenCalledWith(
      expect.objectContaining({ version: '2.0.1-beta.1' })
    )
  })

  it('prepares update quit before requesting application shutdown', () => {
    const calls: string[] = []
    const simulator = createSimulator(() => {
      calls.push('quit')
    })
    simulator.on('before-quit-for-update', () => calls.push('prepare'))

    simulator.quitAndInstall()

    expect(calls).toEqual(['prepare', 'quit'])
  })
})

function createSimulator(onQuitAndInstall: () => void = () => {}) {
  return new DevelopmentUpdateSimulator({
    currentVersion: '2.0.0-beta.18',
    delay: async () => {},
    onQuitAndInstall,
  })
}
