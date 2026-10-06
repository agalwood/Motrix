import { randomUUID } from 'node:crypto'
import { getLogger } from '@core/logger'
import type { SettingsManager } from '@core/settings/settings-manager'
import { Events } from '@shared/protocol/events'
import type { TaskCreateRequest } from '@shared/schemas/add-task'
import {
  type DownloadConfirmRequest,
  resolveDownloadConfirmParamsSchema,
} from '@shared/schemas/download-confirm'
import type { BrowserWindow } from 'electron'
import type { z } from 'zod'
import type { WindowManager } from '../window/window-manager'

/** After an accept, how long the window waits for the task creation to land
 *  before giving up and closing (the creation watch-dog). The confirmation
 *  prompt itself has NO timeout: it waits until the user answers or closes
 *  the window (closing = decline). */
const CREATION_WATCHDOG_MS = 15_000

export interface DownloadConfirmControllerDeps {
  windowManager: WindowManager
  settingsManager: Pick<SettingsManager, 'getApp'>
}

interface PendingConfirm {
  request: TaskCreateRequest
  payload: DownloadConfirmRequest
  /** The amended request after accept — identity-matched in
   *  attachProgress. */
  confirmedRequest: TaskCreateRequest | null
  watchdog: ReturnType<typeof setTimeout> | null
  resolve: (request: TaskCreateRequest | null) => void
}

type ConfirmWindowPayload = DownloadConfirmRequest | { taskId: string }

/**
 * Main-process owner of the IDM-style download confirmation windows.
 *
 * Every bridge-initiated create gets ITS OWN window: several downloads
 * arriving together all pop at once and can be operated independently
 * (accept/cancel/options per window). The bridge create path awaits
 * `confirm()` before creating a task; each window resolves through
 * Commands.ResolveDownloadConfirm. There is no timeout — closing a window
 * (user or shutdown) declines that request only.
 *
 * On ACCEPT the window stays open: handleCreateTask reports the created task
 * id plus the amended request through `attachProgress()`, and that window
 * turns into the progress view for the created task.
 */
export class DownloadConfirmController {
  private readonly pendings = new Map<string, PendingConfirm>()
  private readonly log = getLogger('download-confirm')

  constructor(private readonly deps: DownloadConfirmControllerDeps) {}

  /** Bridge add gate: resolves with the amended request, or null to decline. */
  async confirm(req: TaskCreateRequest): Promise<TaskCreateRequest | null> {
    if (!this.deps.settingsManager.getApp().confirmIncomingDownloads) {
      return req
    }
    const payload = this.toPayload(req)
    const pending: PendingConfirm = {
      request: req,
      payload,
      confirmedRequest: null,
      watchdog: null,
      resolve: () => {},
    }
    return new Promise<TaskCreateRequest | null>((resolve) => {
      pending.resolve = resolve
      this.pendings.set(payload.requestId, pending)
      this.present(pending)
    })
  }

  /** Commands.ResolveDownloadConfirm entry; invalid/stale input is ignored. */
  resolveInput(params: unknown): void {
    const parsed = resolveDownloadConfirmParamsSchema.safeParse(params)
    if (!parsed.success) {
      this.log.warn({ issue: parsed.error.issues[0]?.message }, 'bad input')
      return
    }
    const pending = this.pendings.get(parsed.data.requestId)
    if (!pending) return
    if (parsed.data.action === 'accept') {
      const confirmed = amendRequest(pending.request, parsed.data)
      pending.confirmedRequest = confirmed
      pending.watchdog = setTimeout(() => {
        this.log.warn(
          { requestId: pending.payload.requestId },
          'confirmed task creation never reported; closing window'
        )
        this.deps.windowManager.closeDialog(pending.payload.requestId)
      }, CREATION_WATCHDOG_MS)
      pending.resolve(confirmed)
    } else {
      this.finish(pending, null)
      this.deps.windowManager.closeDialog(parsed.data.requestId)
    }
  }

  /**
   * CreateTaskDeps.onConfirmedTaskCreated entry: handleCreateTask calls this
   * after a bridge create that went through a prompt succeeded. The request
   * identity picks WHICH window flips to the progress view — several
   * confirmed downloads report independently.
   */
  attachProgress(taskId: string, request: TaskCreateRequest): void {
    const pending = this.findByConfirmedRequest(request)
    if (!pending) return
    if (pending.watchdog) {
      clearTimeout(pending.watchdog)
      pending.watchdog = null
    }
    const win = this.deps.windowManager.getDialog(pending.payload.requestId)
    if (!win || win.isDestroyed()) return
    this.sendWhenReady(win, { taskId })
  }

  /** Drop everything without touching the windows (tests, shutdown). */
  cancelAll(): void {
    for (const pending of this.pendings.values()) {
      this.finish(pending, null)
    }
    this.pendings.clear()
  }

  // ─── Private ──────────────────────────────────────────

  private findByConfirmedRequest(
    request: TaskCreateRequest
  ): PendingConfirm | null {
    for (const pending of this.pendings.values()) {
      if (pending.confirmedRequest === request) return pending
    }
    return null
  }

  private toPayload(req: TaskCreateRequest): DownloadConfirmRequest {
    const base = { requestId: randomUUID(), saveDir: req.saveDir }
    if (req.type === 'http') {
      return {
        ...base,
        kind: 'url',
        uri: req.uris[0] ?? '',
        ...(req.filename ? { filename: req.filename } : {}),
        ...(req.connections ? { connections: req.connections } : {}),
        ...(req.dlLimit ? { dlLimit: req.dlLimit } : {}),
      }
    }
    if (req.payload.kind === 'magnet') {
      return {
        ...base,
        kind: 'magnet',
        uri: req.payload.uri,
        ...(req.displayName ? { displayName: req.displayName } : {}),
      }
    }
    return {
      ...base,
      kind: 'torrent',
      ...(req.displayName ? { displayName: req.displayName } : {}),
    }
  }

  private present(pending: PendingConfirm): void {
    const key = pending.payload.requestId
    const win = this.deps.windowManager.openDialog(key)
    win.once('closed', () => {
      // The user dismissed this request's window (or shutdown): decline it.
      // After an accept the promise is already settled, so this no-ops.
      const current = this.pendings.get(key)
      this.pendings.delete(key)
      if (current) this.finish(current, null)
    })
    this.sendWhenReady(win, pending.payload)
  }

  /** Same load-race strategy as the shell's dispatchWhenReady(): the window
   *  renderer is code-split, so defer until React subscriptions are live. */
  private sendWhenReady(
    win: BrowserWindow,
    payload: ConfirmWindowPayload
  ): void {
    const channel =
      'taskId' in payload
        ? Events.DownloadProgressAttached
        : Events.DownloadConfirmRequested
    const send = () => {
      setTimeout(() => {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, payload)
        }
      }, 100)
    }
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', () => send())
    } else {
      send()
    }
  }

  private finish(
    pending: PendingConfirm,
    result: TaskCreateRequest | null
  ): void {
    if (pending.watchdog) clearTimeout(pending.watchdog)
    pending.resolve(result)
  }
}

/** Apply the dialog's edits. Filename is an engine naming hint for http
 *  tasks only; an empty edit falls back to auto naming. Connections
 *  (engine split) and dlLimit (per-task cap, bytes/s) are http-only. */
function amendRequest(
  req: TaskCreateRequest,
  edits: Extract<
    z.infer<typeof resolveDownloadConfirmParamsSchema>,
    { action: 'accept' }
  >
): TaskCreateRequest {
  if (req.type !== 'http') return { ...req, saveDir: edits.saveDir }
  const trimmed = edits.filename?.trim()
  return {
    ...req,
    saveDir: edits.saveDir,
    ...(trimmed ? { filename: trimmed } : {}),
    ...(edits.connections ? { connections: edits.connections } : {}),
    ...(edits.dlLimit ? { dlLimit: edits.dlLimit } : {}),
  }
}
