import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockSetAsDefault,
  mockRemoveDefault,
  mockIsDefault,
  mockIsPackaged,
  mockSend,
  mockReadFile,
  mockParse,
} = vi.hoisted(() => ({
  mockSetAsDefault: vi.fn(),
  mockRemoveDefault: vi.fn(),
  mockIsDefault: vi.fn(),
  mockIsPackaged: { value: true },
  mockSend: vi.fn(),
  mockReadFile: vi.fn(),
  mockParse: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    setAsDefaultProtocolClient: mockSetAsDefault,
    removeAsDefaultProtocolClient: mockRemoveDefault,
    isDefaultProtocolClient: mockIsDefault,
    get isPackaged() {
      return mockIsPackaged.value
    },
  },
}))

vi.mock('node:fs/promises', () => ({
  default: { readFile: mockReadFile },
  readFile: mockReadFile,
}))

vi.mock('@core/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

import type { SettingsManager } from '@core/settings/settings-manager'
import type { TorrentParser } from '@core/torrent/torrent-parser'
import { Events } from '@shared/protocol/events'
import { createProtocolManager } from './protocol-manager'

const defaultMeta = {
  name: 'Test',
  infoHash: 'abc',
  totalSize: 100,
  files: [{ index: 1, path: 'test.txt', size: 100, extension: '.txt' }],
  comment: null,
  isPrivate: false,
}

function makeDeps(magnetEnabled = true) {
  const mockWindow = {
    isDestroyed: () => false,
    webContents: { send: mockSend },
    show: vi.fn(),
    focus: vi.fn(),
  }
  const onOpenAddTask = vi.fn()
  const deliverToAddTask = vi.fn()
  const onOpenPluginDetail = vi.fn()
  mockParse.mockResolvedValue(defaultMeta)
  return {
    getWindow: () => mockWindow as never,
    settingsManager: {
      getApp: () => ({ protocols: { magnet: magnetEnabled } }),
    } as unknown as SettingsManager,
    torrentParser: { parse: mockParse } as unknown as TorrentParser,
    onOpenAddTask,
    deliverToAddTask,
    onOpenPluginDetail,
    mockWindow,
  }
}

describe('createProtocolManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsPackaged.value = true
    mockSetAsDefault.mockReturnValue(true)
    mockRemoveDefault.mockReturnValue(true)
    mockIsDefault.mockImplementation((protocol: string) => {
      if (protocol !== 'magnet') return false
      return mockSetAsDefault.mock.calls.some(([value]) => value === 'magnet')
    })
  })

  describe('register', () => {
    it('registers motrix and magnet when magnet is enabled', () => {
      const {
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      } = makeDeps(true)
      const pm = createProtocolManager({
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      })
      expect(pm.register()).toEqual({ magnetMatchesSetting: true })

      expect(mockSetAsDefault).toHaveBeenCalledWith('motrix')
      expect(mockSetAsDefault).toHaveBeenCalledWith('magnet')
    })

    it('removes magnet when disabled', () => {
      const {
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      } = makeDeps(false)
      const pm = createProtocolManager({
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      })
      expect(pm.register()).toEqual({ magnetMatchesSetting: true })

      expect(mockSetAsDefault).toHaveBeenCalledWith('motrix')
      expect(mockRemoveDefault).toHaveBeenCalledWith('magnet')
    })

    it('skips registration in dev mode', () => {
      mockIsPackaged.value = false
      const {
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      } = makeDeps(true)
      const pm = createProtocolManager({
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      })
      expect(pm.register()).toEqual({ magnetMatchesSetting: null })

      expect(mockSetAsDefault).not.toHaveBeenCalled()
    })

    it('leaves Windows scheme registration to the installer', () => {
      const {
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      } = makeDeps(true)
      const pm = createProtocolManager({
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
        platform: 'win32',
      })
      expect(pm.register()).toEqual({ magnetMatchesSetting: null })

      expect(mockSetAsDefault).not.toHaveBeenCalled()
      expect(mockRemoveDefault).not.toHaveBeenCalled()
    })

    it('skips Electron scheme registration in an AppImage (integration owns it)', () => {
      const {
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      } = makeDeps(true)
      const pm = createProtocolManager({
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
        isAppImage: true,
      })
      expect(pm.register()).toEqual({ magnetMatchesSetting: null })

      expect(mockSetAsDefault).not.toHaveBeenCalled()
      expect(mockRemoveDefault).not.toHaveBeenCalled()
    })

    it('reports when the effective magnet default does not match the setting', () => {
      const {
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      } = makeDeps(true)
      mockSetAsDefault.mockReturnValue(false)
      mockIsDefault.mockReturnValue(false)
      const pm = createProtocolManager({
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      })

      expect(pm.register()).toEqual({ magnetMatchesSetting: false })
    })
  })

  describe('handle', () => {
    it('opens add-task window with magnet in links prefill', () => {
      const {
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      } = makeDeps()
      const pm = createProtocolManager({
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      })
      pm.handle('magnet:?xt=urn:btih:abc123')

      expect(onOpenAddTask).toHaveBeenCalledWith({
        mode: 'links',
        url: 'magnet:?xt=urn:btih:abc123',
      })
    })

    it('opens add-task window with url prefill for http(s)/ftp', () => {
      const {
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      } = makeDeps()
      const pm = createProtocolManager({
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      })
      pm.handle('https://example.com/file.zip')

      expect(onOpenAddTask).toHaveBeenCalledWith({
        mode: 'links',
        url: 'https://example.com/file.zip',
      })
    })

    it('decodes motrix://new-task?uri=<http-url> and opens add-task', () => {
      const {
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      } = makeDeps()
      const pm = createProtocolManager({
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      })
      const encoded = encodeURIComponent('https://example.com/file.zip')
      pm.handle(`motrix://new-task?uri=${encoded}`)

      expect(onOpenAddTask).toHaveBeenCalledWith({
        mode: 'links',
        url: 'https://example.com/file.zip',
      })
    })

    it('decodes motrix://new-task?uri=<magnet> into links prefill', () => {
      const {
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      } = makeDeps()
      const pm = createProtocolManager({
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      })
      const encoded = encodeURIComponent('magnet:?xt=urn:btih:abc')
      pm.handle(`motrix://new-task?uri=${encoded}`)

      expect(onOpenAddTask).toHaveBeenCalledWith({
        mode: 'links',
        url: 'magnet:?xt=urn:btih:abc',
      })
    })

    it('shows window for bare motrix:// URL', () => {
      const {
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
        mockWindow,
      } = makeDeps()
      const pm = createProtocolManager({
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      })
      pm.handle('motrix://')

      expect(mockWindow.show).toHaveBeenCalled()
      expect(onOpenAddTask).not.toHaveBeenCalled()
    })

    it('routes motrix://plugins/<id> to the plugin detail navigation', () => {
      const {
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
        mockWindow,
      } = makeDeps()
      const pm = createProtocolManager({
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      })
      pm.handle('motrix://plugins/example.archive-unpacker')

      expect(onOpenPluginDetail).toHaveBeenCalledWith(
        'example.archive-unpacker'
      )
      expect(onOpenAddTask).not.toHaveBeenCalled()
      expect(mockWindow.show).not.toHaveBeenCalled()
    })

    it('rejects malformed plugin deeplink ids and shows the window', () => {
      const {
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
        mockWindow,
      } = makeDeps()
      const pm = createProtocolManager({
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      })
      // No dot namespace / uppercase / traversal-looking ids are all refused.
      pm.handle('motrix://plugins/no-namespace')
      pm.handle('motrix://plugins/Upper.Case')
      pm.handle('motrix://plugins/../etc')

      expect(onOpenPluginDetail).not.toHaveBeenCalled()
      expect(mockWindow.show).toHaveBeenCalled()
    })
  })

  describe('handleTorrentFile', () => {
    it('delivers parsed torrent + meta to add-task window', async () => {
      mockReadFile.mockResolvedValue(Buffer.from('fake-torrent-data'))

      const {
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      } = makeDeps()
      const pm = createProtocolManager({
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      })
      await pm.handleTorrentFile('/path/to/test.torrent')

      expect(deliverToAddTask).toHaveBeenCalledWith(
        Events.ProtocolTorrentFile,
        expect.objectContaining({
          payload: {
            name: 'test.torrent',
            dataBase64: Buffer.from('fake-torrent-data').toString('base64'),
          },
          meta: defaultMeta,
          queuePosition: 1,
          queueTotal: 1,
        })
      )
    })

    it('ignores non-torrent files', async () => {
      const {
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      } = makeDeps()
      const pm = createProtocolManager({
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      })
      await pm.handleTorrentFile('/path/to/file.txt')

      expect(mockReadFile).not.toHaveBeenCalled()
    })
  })

  describe('torrent queue', () => {
    it('queues multiple torrents and serves one at a time', async () => {
      mockReadFile
        .mockResolvedValueOnce(Buffer.from('torrent-1'))
        .mockResolvedValueOnce(Buffer.from('torrent-2'))

      const {
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      } = makeDeps()
      const pm = createProtocolManager({
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      })
      await pm.handleTorrentFile('/path/to/a.torrent')
      await pm.handleTorrentFile('/path/to/b.torrent')

      expect(deliverToAddTask).toHaveBeenCalledWith(
        Events.ProtocolTorrentFile,
        expect.objectContaining({ queuePosition: 1, queueTotal: 1 })
      )

      expect(deliverToAddTask).toHaveBeenCalledWith(
        Events.TorrentQueueSizeChanged,
        expect.objectContaining({ queueTotal: 2 })
      )
    })

    it('nextTorrent advances the queue', async () => {
      mockReadFile
        .mockResolvedValueOnce(Buffer.from('torrent-1'))
        .mockResolvedValueOnce(Buffer.from('torrent-2'))

      const {
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      } = makeDeps()
      const pm = createProtocolManager({
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      })
      await pm.handleTorrentFile('/path/to/a.torrent')
      await pm.handleTorrentFile('/path/to/b.torrent')
      deliverToAddTask.mockClear()

      expect(pm.nextTorrent()).toBe(true)

      expect(deliverToAddTask).toHaveBeenCalledWith(
        Events.ProtocolTorrentFile,
        expect.objectContaining({
          payload: expect.objectContaining({ name: 'b.torrent' }),
        })
      )
    })

    it('reports exhaustion when a pending next torrent fails to parse', async () => {
      mockReadFile
        .mockResolvedValueOnce(Buffer.from('torrent-1'))
        .mockResolvedValueOnce(Buffer.from('broken-torrent'))
      let rejectBroken!: (error: Error) => void
      mockParse.mockResolvedValueOnce(defaultMeta).mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectBroken = reject
          })
      )

      const deps = makeDeps()
      const pm = createProtocolManager(deps)
      await pm.handleTorrentFile('/path/to/a.torrent')
      const pendingBroken = pm.handleTorrentFile('/path/to/broken.torrent')
      const advancing = pm.nextTorrent()
      await vi.waitFor(() => expect(rejectBroken).toBeTypeOf('function'))
      rejectBroken(new Error('invalid torrent'))

      await expect(advancing).resolves.toBe(false)
      await pendingBroken
      expect(pm.getTorrentQueueSize()).toBe(0)
    })

    it('downloadAllTorrents drains queue', async () => {
      mockReadFile
        .mockResolvedValueOnce(Buffer.from('torrent-1'))
        .mockResolvedValueOnce(Buffer.from('torrent-2'))

      const {
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      } = makeDeps()
      const pm = createProtocolManager({
        getWindow,
        settingsManager,
        torrentParser,
        onOpenAddTask,
        deliverToAddTask,
        onOpenPluginDetail,
      })
      await pm.handleTorrentFile('/path/to/a.torrent')
      await pm.handleTorrentFile('/path/to/b.torrent')

      pm.downloadAllTorrents()

      expect(pm.getTorrentQueueSize()).toBe(0)
    })
  })
})
