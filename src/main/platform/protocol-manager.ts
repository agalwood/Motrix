import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { getLogger } from '@core/logger'
import type { SettingsManager } from '@core/settings/settings-manager'
import type { TorrentParser } from '@core/torrent/torrent-parser'
import { Events } from '@shared/protocol/events'
import type { AddTaskUrlParams } from '@shared/schemas/add-task'
import { REGISTRY_PLUGIN_ID_RE } from '@shared/schemas/registry'
import type { TorrentMeta } from '@shared/types/torrent'
import type { BrowserWindow } from 'electron'
import { app } from 'electron'

export interface ProtocolManagerDeps {
  getWindow: () => BrowserWindow | null
  settingsManager: SettingsManager
  torrentParser: TorrentParser
  // When running as a packaged Linux AppImage, the AppImage desktop
  // self-integration (src/main/platform/appimage-integration.ts) owns the
  // `motrix:`/`magnet:` scheme defaults via a user-scope `.desktop` file. In
  // that environment we must NOT also call Electron's
  // `setAsDefaultProtocolClient`, which writes its own competing desktop entry
  // and mutates the XDG default — that would race the integration's
  // external-owner detection and corrupt the recorded prior default handler.
  isAppImage?: boolean
  // Windows associations are installer-owned so they can participate in the
  // protected Default Apps UI and be removed reliably on uninstall/update.
  platform?: NodeJS.Platform
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

export interface ProtocolRegistrationResult {
  magnetMatchesSetting: boolean | null
}

interface QueuedTorrent {
  payload: {
    name: string
    dataBase64: string
  }
  meta: TorrentMeta
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
  const torrentQueue: QueuedTorrent[] = []
  let dialogActive = false
  let totalSent = 0
  let torrentIngress = Promise.resolve()
  let pendingIngestions = 0
  let queueGeneration = 0
  let currentTorrentDelivered = false
  let lastReportedQueueTotal = 0

  function getKnownQueueTotal(currentIngestion = false) {
    const alreadyRemoved = currentTorrentDelivered ? totalSent - 1 : totalSent
    const notYetQueued = Math.max(
      0,
      pendingIngestions - (currentIngestion ? 1 : 0)
    )
    return alreadyRemoved + torrentQueue.length + notYetQueued
  }

  function sendNextTorrentToRenderer() {
    if (torrentQueue.length === 0) {
      dialogActive = false
      currentTorrentDelivered = false
      lastReportedQueueTotal = 0
      return false
    }
    dialogActive = true
    totalSent++
    currentTorrentDelivered = true
    const torrent = torrentQueue[0]
    const queueTotal = getKnownQueueTotal()
    lastReportedQueueTotal = queueTotal
    deps.deliverToAddTask(Events.ProtocolTorrentFile, {
      payload: torrent.payload,
      meta: torrent.meta,
      queuePosition: totalSent,
      queueTotal,
    })
    return true
  }

  async function ingestTorrentFile(filePath: string, generation: number) {
    log.info({ filePath }, 'torrent file received')

    try {
      const data = await readFile(filePath)
      const dataBase64 = data.toString('base64')
      const meta = await deps.torrentParser.parse(dataBase64)
      if (generation !== queueGeneration) return

      const torrent: QueuedTorrent = {
        payload: {
          name: basename(filePath),
          dataBase64,
        },
        meta,
      }

      torrentQueue.push(torrent)

      if (!dialogActive) {
        totalSent = 0
        dialogActive = true
        totalSent++
        currentTorrentDelivered = true
        const queueTotal = getKnownQueueTotal(true)
        lastReportedQueueTotal = queueTotal
        log.info(
          { name: torrent.payload.name, infoHash: meta.infoHash },
          'delivering torrent to add-task'
        )
        deps.deliverToAddTask(Events.ProtocolTorrentFile, {
          payload: torrent.payload,
          meta,
          queuePosition: totalSent,
          queueTotal,
        })
      } else {
        const queueTotal = getKnownQueueTotal(true)
        lastReportedQueueTotal = queueTotal
        deps.deliverToAddTask(Events.TorrentQueueSizeChanged, {
          queueTotal,
        })
      }
    } catch (err) {
      log.warn({ err, filePath }, 'failed to read/parse torrent file')
    }
  }

  return {
    register() {
      if (!app.isPackaged) return { magnetMatchesSetting: null }

      if ((deps.platform ?? process.platform) === 'win32') {
        log.info('windows: scheme registration owned by installer')
        return { magnetMatchesSetting: null }
      }

      // In an AppImage, the desktop self-integration owns scheme registration;
      // calling Electron's registrar here would fight it. See ProtocolManagerDeps.
      if (deps.isAppImage) {
        log.info('appimage: scheme registration owned by desktop integration')
        return { magnetMatchesSetting: null }
      }

      const magnetEnabled = deps.settingsManager.getApp().protocols.magnet
      try {
        app.setAsDefaultProtocolClient('motrix')
        if (magnetEnabled) {
          app.setAsDefaultProtocolClient('magnet')
        } else {
          app.removeAsDefaultProtocolClient('magnet')
        }

        const magnetIsDefault = app.isDefaultProtocolClient('magnet')
        const magnetMatchesSetting = magnetEnabled
          ? magnetIsDefault
          : !magnetIsDefault
        log.info(
          { magnetEnabled, magnetMatchesSetting },
          'protocols registered'
        )
        return { magnetMatchesSetting }
      } catch (err) {
        log.warn({ err, magnetEnabled }, 'protocol registration failed')
        return { magnetMatchesSetting: false }
      }
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

    handleTorrentFile(filePath: string) {
      if (extname(filePath).toLowerCase() !== '.torrent') {
        return Promise.resolve()
      }

      // Windows/Linux can pass several associated files in one argv. Keep
      // parsing serial so the review queue follows the user's file order even
      // when individual reads/parses complete at different speeds.
      const generation = queueGeneration
      pendingIngestions += 1
      const result = torrentIngress
        .then(() => ingestTorrentFile(filePath, generation))
        .finally(() => {
          pendingIngestions -= 1
          if (
            generation === queueGeneration &&
            dialogActive &&
            currentTorrentDelivered
          ) {
            const queueTotal = getKnownQueueTotal()
            if (queueTotal > 0 && queueTotal !== lastReportedQueueTotal) {
              lastReportedQueueTotal = queueTotal
              deps.deliverToAddTask(Events.TorrentQueueSizeChanged, {
                queueTotal,
              })
            }
          }
        })
      torrentIngress = result.catch(() => undefined)
      return result
    },

    nextTorrent() {
      torrentQueue.shift()
      currentTorrentDelivered = false
      if (torrentQueue.length === 0 && pendingIngestions > 0) {
        return torrentIngress.then(() => sendNextTorrentToRenderer())
      }
      return sendNextTorrentToRenderer()
    },

    downloadAllTorrents() {
      const takeAll = () => {
        const torrents = torrentQueue.splice(0)
        log.info(
          { count: torrents.length },
          'taking all remaining torrents for batch creation'
        )
        dialogActive = false
        currentTorrentDelivered = false
        lastReportedQueueTotal = 0
        totalSent = 0
        return torrents
      }
      return pendingIngestions > 0
        ? torrentIngress.then(() => takeAll())
        : takeAll()
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
      currentTorrentDelivered = false
      lastReportedQueueTotal = 0
      totalSent = 0
      queueGeneration += 1
    },

    getTorrentQueueSize() {
      return torrentQueue.length
    },
  }
}
