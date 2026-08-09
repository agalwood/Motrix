import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { electronServices } from './electron-services'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn() },
}))

describe('electronServices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('pickSaveDir returns path on user confirm', async () => {
    vi.mocked(transport.invoke).mockResolvedValueOnce({ path: '/u/a/d' })
    const result = await electronServices.pickSaveDir('/prev')
    expect(result).toBe('/u/a/d')
    expect(transport.invoke).toHaveBeenCalledWith(Commands.PickSaveDir, {
      defaultPath: '/prev',
    })
  })

  it('pickSaveDir returns null on cancel', async () => {
    vi.mocked(transport.invoke).mockResolvedValueOnce(null)
    expect(await electronServices.pickSaveDir()).toBeNull()
  })

  it('closeHost invokes CloseCurrentWindow', async () => {
    vi.mocked(transport.invoke).mockResolvedValueOnce(undefined)
    await electronServices.closeHost({ showMain: false })
    expect(transport.invoke).toHaveBeenCalledWith(Commands.CloseCurrentWindow, {
      showMain: false,
    })
  })

  it('closeHost defaults showMain to true', async () => {
    vi.mocked(transport.invoke).mockResolvedValueOnce(undefined)
    await electronServices.closeHost()
    expect(transport.invoke).toHaveBeenCalledWith(Commands.CloseCurrentWindow, {
      showMain: true,
    })
  })

  it('closeHost forwards navigateMainTo through IPC', async () => {
    vi.mocked(transport.invoke).mockResolvedValueOnce(undefined)
    await electronServices.closeHost({
      showMain: true,
      navigateMainTo: '/downloads',
    })
    expect(transport.invoke).toHaveBeenCalledWith(Commands.CloseCurrentWindow, {
      showMain: true,
      navigateMainTo: '/downloads',
    })
  })
})
