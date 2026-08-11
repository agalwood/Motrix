import { transport } from '@renderer/lib/transport'
import { Commands } from '@shared/protocol/commands'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { electronServices } from './electron-services'
import { sha256File } from './plugin-install-file'

vi.mock('@renderer/lib/transport', () => ({
  transport: { invoke: vi.fn() },
}))
vi.mock('./plugin-install-file', () => ({
  sha256File: vi.fn(async () => 'a'.repeat(64)),
}))

describe('electronServices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.motrix = {
      getPathForFile: vi.fn(() => '/host/plugin.moext'),
    } as never
  })

  it('converts a selected file through the Electron host capability', async () => {
    const file = new File(['plugin'], 'plugin.moext')
    await expect(
      electronServices.pluginInstallFile?.prepare(file)
    ).resolves.toEqual({
      sourceType: 'local',
      absPath: '/host/plugin.moext',
      fileHash: 'a'.repeat(64),
    })
    expect(window.motrix?.getPathForFile).toHaveBeenCalledWith(file)
    expect(sha256File).toHaveBeenCalledWith(file)
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
