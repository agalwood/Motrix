import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { getLogger } from '@core/logger'
import type { SettingsManager } from '@core/settings/settings-manager'
import type { TorrentParser } from '@core/torrent/torrent-parser'
import { Events } from '@shared/protocol/events'
import type { AddTaskUrlParams } from '@shared/schemas/add-task'
import { REGISTRY_PLUGIN_ID_RE } from '@shared/schemas/registry'
import type { BrowserWindow } from 'electron'
import { app } from 'electron'

export interface ProtocolManagerDeps {
  getWindow: () => BrowserWindow | null
  settingsManager: SettingsManager
  torrentParser: TorrentParser
  // Open (or focus) the add-task window with URL prefill. Wired in
  // main/index.ts to open the window + dispatch SetAddTaskMode once the
  // renderer's first paint + useEffect have completed.
  onOpenAddTask: (params: AddTaskUrlParams) => void
  // Same open-then-dispatch path for arbitrary IPC events carrying rich
  // payloads (parsed torrent meta, queue size updates) that can't be
  // encoded as AddTaskUrlParams.
  deliverToAddTask: (channel: string, payload: unknown) => void
  // motrix://plugins/<id> — navigate the main window to a plugin's
  // marketplace detail route. Navigation-only by contract: the deeplink must
  // never carry or trigger an install (.claude/rules/plugin-registry.md).
  onOpenPluginDetail: (pluginId: string) => void
}

interface TorrentPayload {
  name: string
  dataBase64: string
}

const RESOURCE_PREFIXES = ['magnet:', 'http:', 'https:', 'ftp:']

function uriToAddTaskParams(url: string): AddTaskUrlParams | null {
  const lower = url.toLowerCase()
  if (lower.startsWith('magnet:')) {
    return { mode: 'links', url }
  }
  if (
    lower.startsWith('http:') ||
    lower.startsWith('https:') ||
    lower.startsWith('ftp:')
  ) {
    return { mode: 'links', url }
  }
  return null
}

export function createProtocolManager(deps: ProtocolManagerDeps) {
  const log = getLogger('protocol')
  const torrentQueue: TorrentPayload[] = []
  let dialogActive = false
  let totalSent = 0

  function sendNextTorrentToRenderer() {
    if (torrentQueue.length === 0) {
      dialogActive = false
      return
    }
    dialogActive = true
    totalSent++
    deps.deliverToAddTask(Events.ProtocolTorrentFile, {
      payload: torrentQueue[0],
      queuePosition: totalSent,
      queueTotal: totalSent + torrentQueue.length - 1,
    })
  }

  return {
    register() {
      if (!app.isPackaged) return

      app.setAsDefaultProtocolClient('motrix')

      const magnetEnabled = deps.settingsManager.getApp().protocols.magnet
      if (magnetEnabled) {
        app.setAsDefaultProtocolClient('magnet')
      } else {
        app.removeAsDefaultProtocolClient('magnet')
      }

      log.info({ magnetEnabled }, 'protocols registered')
    },

    handle(url: string) {
      log.info({ url }, 'protocol url received')
      const lower = url.toLowerCase()

      if (RESOURCE_PREFIXES.some((p) => lower.startsWith(p))) {
        const params = uriToAddTaskParams(url)
        if (params) {
          log.info({ params }, 'opening add-task with prefill')
          deps.onOpenAddTask(params)
        }
        return
      }

      if (lower.startsWith('motrix://')) {
        try {
          const parsed = new URL(url)
          if (
            parsed.hostname === 'new-task' &&
            parsed.searchParams.has('uri')
          ) {
            const uri = parsed.searchParams.get('uri') ?? ''
            const params = uriToAddTaskParams(uri)
            if (params) {
              log.info({ params }, 'opening add-task from motrix:// uri')
              deps.onOpenAddTask(params)
              return
            }
          }
          if (parsed.hostname === 'plugins') {
            const pluginId = decodeURIComponent(
              parsed.pathname.replace(/^\//, '')
            )
            if (REGISTRY_PLUGIN_ID_RE.test(pluginId)) {
              log.info({ pluginId }, 'opening plugin detail from motrix:// url')
              deps.onOpenPluginDetail(pluginId)
              return
            }
            log.warn({ pluginId }, 'rejecting malformed plugin deeplink id')
          }
        } catch {
          /* invalid URL — fall through to show window */
        }

        const win = deps.getWindow()
        if (win) {
          win.show()
          win.focus()
        }
        return
      }

      log.warn({ url }, 'unrecognized protocol url')
    },

    async handleTorrentFile(filePath: string) {
      if (extname(filePath).toLowerCase() !== '.torrent') return

      log.info({ filePath }, 'torrent file received')

      try {
        const data = await readFile(filePath)
        const dataBase64 = data.toString('base64')
        const meta = await deps.torrentParser.parse(dataBase64)

        const payload: TorrentPayload = {
          name: basename(filePath),
          dataBase64,
        }

        torrentQueue.push(payload)

        if (!dialogActive) {
          totalSent = 0
          dialogActive = true
          totalSent++
          log.info(
            { name: payload.name, infoHash: meta.infoHash },
            'delivering torrent to add-task'
          )
          deps.deliverToAddTask(Events.ProtocolTorrentFile, {
            payload,
            meta,
            queuePosition: totalSent,
            queueTotal: totalSent + torrentQueue.length - 1,
          })
        } else {
          deps.deliverToAddTask(Events.TorrentQueueSizeChanged, {
            queueTotal: totalSent + torrentQueue.length - 1,
          })
        }
      } catch (err) {
        log.warn({ err, filePath }, 'failed to read/parse torrent file')
      }
    },

    nextTorrent() {
      torrentQueue.shift()
      sendNextTorrentToRenderer()
    },

    downloadAllTorrents() {
      log.info(
        { count: torrentQueue.length },
        'downloading all remaining torrents'
      )
      torrentQueue.length = 0
      dialogActive = false
      totalSent = 0
    },

    // Called by main/index.ts when the add-task window is closed/destroyed.
    // Without this reset, dialogActive stays true forever after the first
    // .torrent open, and the next .torrent dispatches via the queue-increment
    // path (TorrentQueueSizeChanged) instead of ProtocolTorrentFile — which
    // means the freshly-opened add-task window never receives meta/files and
    // stays stuck on the default Links tab.
    resetDialogState() {
      log.info(
        { hadPending: torrentQueue.length, wasActive: dialogActive },
        'resetting dialog state on add-task window close'
      )
      torrentQueue.length = 0
      dialogActive = false
      totalSent = 0
    },

    getTorrentQueueSize() {
      return torrentQueue.length
    },
  }
}
