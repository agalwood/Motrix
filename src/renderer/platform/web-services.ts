import { toast } from '@renderer/components/ui/toast'
import { i18n } from '@renderer/lib/i18n'
import type { PlatformServices } from './services'

const SHA256_RE = /^[0-9a-f]{64}$/

export type PickRequest = {
  id: number
  defaultPath?: string
  allowFavoriteEditing?: boolean
  opener: HTMLElement | null
}
type PickListener = (req: PickRequest) => void

export class PathPickerBus {
  private listeners: Set<PickListener> = new Set()
  private pending: { id: number; resolve: (v: string | null) => void } | null =
    null
  private latestId = 0

  subscribe(cb: PickListener): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
      if (this.listeners.size === 0 && this.pending)
        this.resolve(this.pending.id, null)
    }
  }

  request(req: {
    defaultPath?: string
    allowFavoriteEditing?: boolean
  }): Promise<string | null> {
    const id = ++this.latestId
    const opener =
      typeof document !== 'undefined' &&
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    if (this.pending) {
      this.pending.resolve(null)
      this.pending = null
    }
    if (this.listeners.size === 0) return Promise.resolve(null)
    return new Promise((resolve) => {
      this.pending = { id, resolve }
      for (const l of this.listeners) l({ ...req, id, opener })
    })
  }

  resolve(id: number, value: string | null): void {
    if (this.pending?.id === id) {
      this.pending.resolve(value)
      this.pending = null
    }
  }

  canRestoreFocus(id: number): boolean {
    return this.latestId === id && this.pending === null
  }
}

// Exported for the DialogHost to subscribe; also for tests.
export const __webPathPickerBus = new PathPickerBus()

let __webCloseHandler: (() => void) | null = null

// Called by AddTaskDialogHost on mount (Task 23) to register its close fn.
// Pass `null` on unmount to avoid stale closures.
export function __setWebCloseHandler(fn: (() => void) | null): void {
  __webCloseHandler = fn
}

export interface WebServicesOptions {
  fetchImpl?: typeof fetch
  baseUrl?: string
}

export function createWebServices(
  options: WebServicesOptions = {}
): PlatformServices {
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis)
  const baseUrl = options.baseUrl ?? globalThis.location?.origin ?? ''
  return {
    kind: 'web',

    pluginInstallFile: {
      mode: 'upload',
      async prepare(file) {
        const response = await fetchImpl(`${baseUrl}/api/plugins/uploads`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'content-type': 'application/vnd.motrix.moext',
            'x-motrix-file-name': encodeURIComponent(file.name),
          },
          body: file,
        })
        if (!response.ok) {
          const detail = await response.text()
          throw new Error(
            `Plugin upload failed (${response.status}): ${detail}`
          )
        }
        const reference = (await response.json()) as {
          uploadId?: unknown
          fileHash?: unknown
        }
        if (
          typeof reference.uploadId !== 'string' ||
          typeof reference.fileHash !== 'string' ||
          !SHA256_RE.test(reference.fileHash)
        ) {
          throw new Error('Plugin upload returned an invalid reference')
        }
        return {
          sourceType: 'upload',
          uploadId: reference.uploadId,
          fileHash: reference.fileHash,
        }
      },
    },

    pickSaveDir(defaultPath, options) {
      return __webPathPickerBus.request({ defaultPath, ...options })
    },

    closeHost() {
      __webCloseHandler?.()
    },

    async readClipboard() {
      try {
        return await navigator.clipboard.readText()
      } catch {
        return ''
      }
    },

    openExternal(url) {
      if (/^(https?|mailto):/i.test(url)) {
        window.open(url, '_blank', 'noopener,noreferrer')
      }
    },

    notify(kind, messageKey, values) {
      const msg = i18n.t(messageKey, values)
      if (kind === 'error') toast.add({ title: msg, type: 'error' })
      else if (kind === 'warn') toast.add({ title: msg, type: 'warning' })
      else toast.add({ title: msg, type: 'info' })
    },
  }
}

export const webServices = createWebServices()
