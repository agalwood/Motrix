// @vitest-environment node

import type { OperationService } from '@core/plugin/operations/operation-service'
import { Commands } from '@shared/protocol/commands'
import { BrowserWindow, dialog, type WebContents } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { desktopOperationHandlers } from './operation-commands'

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
    showMessageBox: vi.fn(),
  },
  shell: { showItemInFolder: vi.fn() },
}))
vi.mock('../lib/i18n', () => ({ i18n: { t: () => 'Files' } }))
const request = {
  draftId: '00000000-0000-4000-8000-000000000001',
  field: 'input',
  values: {},
}
const sender = { id: 7, isDestroyed: () => false } as WebContents
const picker = vi.fn()
const pick = vi.fn()
const handlers = desktopOperationHandlers({
  picker,
  pick,
  selectionIdentity: () =>
    'community.text-tools / community.text-tools.deduplicate',
} as unknown as OperationService)
beforeEach(() => {
  vi.clearAllMocks()
  picker.mockReturnValue({ kind: 'open', extensions: ['txt'] })
  vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(null)
})
describe('desktop operation file authorization', () => {
  it('rejects renderer-supplied paths before opening any dialog', async () => {
    await expect(
      invokePicker(sender, {
        ...request,
        candidate: '/unauthorized/input.txt',
      })
    ).rejects.toThrow()
    expect(dialog.showOpenDialog).not.toHaveBeenCalled()
    expect(pick).not.toHaveBeenCalled()
  })
  it('requires a native confirmation for dropped paths and cancellation mints nothing', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({
      response: 0,
      checkboxChecked: false,
    })
    expect(
      await invokePicker(sender, {
        ...request,
        dropCandidate: '/dropped/input.txt',
      })
    ).toBeNull()
    expect(pick).not.toHaveBeenCalled()
    vi.mocked(dialog.showMessageBox).mockResolvedValue({
      response: 1,
      checkboxChecked: false,
    })
    await invokePicker(sender, {
      ...request,
      dropCandidate: '/dropped/input.txt',
    })
    expect(pick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'electron:7' }),
      { ...request, candidate: '/dropped/input.txt' }
    )
  })
  it('does not accept dropped output paths', async () => {
    picker.mockReturnValue({ kind: 'save' })
    await expect(
      invokePicker(sender, { ...request, dropCandidate: '/dropped/output.txt' })
    ).rejects.toThrow('invalidFile')
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    expect(pick).not.toHaveBeenCalled()
  })
  it('binds only the native selection to the current window principal', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: ['/chosen/input.txt'],
    })
    await invokePicker(sender, request)
    expect(pick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'electron:7' }),
      { ...request, candidate: '/chosen/input.txt' }
    )
  })
  it('does not mint a file grant when the picker is cancelled', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: true,
      filePaths: [],
    })
    expect(await invokePicker(sender, request)).toBeNull()
    expect(pick).not.toHaveBeenCalled()
  })
})

function invokePicker(sender: WebContents, value: unknown) {
  const handler = handlers[Commands.PickPluginOperationFile]
  if (!handler) throw new Error('Missing operation picker')
  return handler(sender, value)
}
