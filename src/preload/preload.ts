import {
  BridgeCommands,
  BridgeEvents,
  BridgeQueries,
} from '@shared/protocol/bridge'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import { Queries } from '@shared/protocol/queries'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { MotrixAPI } from './api'

type Callback = (...args: unknown[]) => void
type IpcListener = (
  event: Electron.IpcRendererEvent,
  ...args: unknown[]
) => void
interface CallbackSubscription {
  active: boolean
  receivedLiveEvent: boolean
  deliver: Callback
  remove(): void
}
interface ChannelSubscription {
  listener: IpcListener
  callbacks: Map<Callback, CallbackSubscription>
}
// A renderer can have many consumers of the same event. Keep one native IPC
// listener per channel, with independent subscriptions and replay cancellation.
const subscriptions = new Map<string, ChannelSubscription>()

const INVOKE_CHANNELS = new Set<string>([
  ...Object.values(Commands),
  ...Object.values(Queries),
  ...Object.values(BridgeCommands),
  ...Object.values(BridgeQueries),
])
const EVENT_CHANNELS = new Set<string>([
  ...Object.values(Events),
  ...Object.values(BridgeEvents),
])
const PLUGIN_LOG_CHANNEL_RE = new RegExp(
  `^${Events.PluginLog}:[a-z0-9-]+(?:\\.[a-z0-9-]+)+$`
)

function assertInvokeChannel(channel: string): void {
  if (!INVOKE_CHANNELS.has(channel)) {
    throw new Error(`Blocked undeclared IPC invoke channel: ${channel}`)
  }
}

function assertEventChannel(channel: string): void {
  if (!EVENT_CHANNELS.has(channel) && !PLUGIN_LOG_CHANNEL_RE.test(channel)) {
    throw new Error(`Blocked undeclared IPC event channel: ${channel}`)
  }
}

// Eager replay buffer for cold-start protocol/file events.
//
// Problem: the add-task window's renderer is code-split via React.lazy,
// so React's useEffect (which subscribes to these IPC channels) runs
// hundreds of ms AFTER did-finish-load. The main process tries to
// dispatch protocol-driven events (magnet click, .torrent file open)
// right after the page loads — those land in the renderer process
// before any consumer is attached, and ipcRenderer drops them silently.
//
// Fix: preload runs synchronously before page JS, so we attach eager
// listeners here that buffer the first send for each cold-start
// channel. When the renderer eventually calls `motrix.on(channel, cb)`,
// we replay the buffer to that callback, then disengage the eager
// listener so subsequent events flow through the shared channel listener.
const BUFFERED_CHANNELS = new Set<string>([
  Events.SetAddTaskMode,
  Events.ProtocolTorrentFile,
  Events.MagnetFileSelection,
  Events.TorrentQueueSizeChanged,
  // Cold-start deeplinks (motrix://plugins/<id>) dispatch NavigateTo before
  // AppLayout's listener mounts — buffer so the navigation replays.
  Events.NavigateTo,
  // Window URLs carry the initial locale, but a change can still land between
  // navigation and LanguageSync's effect. Replay the latest change on mount.
  Events.LocaleChanged,
  // The main process publishes the current value on did-finish-load. Buffer it
  // until WindowChrome mounts so reloads while maximized render Restore.
  Events.WindowMaximizedChanged,
])
const REPLAY_LATEST_CHANNELS = new Set<string>([
  Events.LocaleChanged,
  Events.WindowMaximizedChanged,
])
const replayBuffer = new Map<string, unknown[][]>()
const eagerListeners = new Map<string, IpcListener>()

for (const channel of BUFFERED_CHANNELS) {
  const eager: IpcListener = (_event, ...args) => {
    if (REPLAY_LATEST_CHANNELS.has(channel)) {
      replayBuffer.set(channel, [args])
      return
    }
    let bucket = replayBuffer.get(channel)
    if (!bucket) {
      bucket = []
      replayBuffer.set(channel, bucket)
    }
    // Transitional consumers are bounded even before their first subscription.
    if (bucket.length >= 32) bucket.shift()
    bucket.push(args)
  }
  eagerListeners.set(channel, eager)
  ipcRenderer.on(channel, eager)
}

const api: MotrixAPI = {
  invoke: (channel, ...args) => {
    assertInvokeChannel(channel)
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel, callback) => {
    assertEventChannel(channel)
    let subscription = subscriptions.get(channel)
    const existing = subscription?.callbacks.get(callback)
    if (existing) return existing.remove
    if (!subscription) {
      const callbacks = new Map<Callback, CallbackSubscription>()
      const listener: IpcListener = (_event, ...args) => {
        for (const current of [...callbacks.values()]) {
          if (!current.active) continue
          current.receivedLiveEvent = true
          current.deliver(...args)
        }
      }
      subscription = { listener, callbacks }
      subscriptions.set(channel, subscription)
      const eager = eagerListeners.get(channel)
      if (eager) {
        ipcRenderer.removeListener(channel, eager)
        eagerListeners.delete(channel)
      }
      ipcRenderer.on(channel, listener)
    }
    const registered = subscription
    const current: CallbackSubscription = {
      active: true,
      receivedLiveEvent: false,
      remove: () => {
        if (!current.active) return
        current.active = false
        registered.callbacks.delete(callback)
        if (registered.callbacks.size === 0) {
          ipcRenderer.removeListener(channel, registered.listener)
          subscriptions.delete(channel)
        }
      },
      deliver: (...args) => {
        try {
          callback(...args)
        } catch (error) {
          // Surface the failure without starving the other event consumers.
          queueMicrotask(() => {
            throw error
          })
        }
      },
    }
    subscription.callbacks.set(callback, current)

    const buffered = replayBuffer.get(channel)
    if (buffered && buffered.length > 0) {
      replayBuffer.delete(channel)
      // Defer to next microtask so the caller's `on()` chain finishes
      // (e.g. useEffect attaching the listener) before we invoke the
      // callback, matching the normal async IPC arrival contract.
      queueMicrotask(() => {
        if (!current.active) return
        if (REPLAY_LATEST_CHANNELS.has(channel) && current.receivedLiveEvent)
          return
        for (const args of buffered) {
          if (!current.active) break
          current.deliver(...args)
        }
      })
    }
    // Returning a closure avoids comparing callback proxies across worlds.
    return current.remove
  },
  platform: process.platform,
  getPathForFile: (file) => webUtils.getPathForFile(file),
}

contextBridge.exposeInMainWorld('motrix', api)

// ─── Global drop handler ───────────────────────────────

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunks: string[] = []
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)))
  }
  return btoa(chunks.join(''))
}

window.addEventListener('dragover', (e) => {
  e.preventDefault()
})

window.addEventListener('drop', (e) => {
  e.preventDefault()
  for (const file of e.dataTransfer?.files ?? []) {
    if (file.name.toLowerCase().endsWith('.torrent')) {
      const reader = new FileReader()
      reader.onload = () => {
        const base64 = arrayBufferToBase64(reader.result as ArrayBuffer)
        ipcRenderer
          .invoke(Commands.HandleDroppedTorrent, { base64, name: file.name })
          .catch(() => {})
      }
      reader.readAsArrayBuffer(file)
    }
  }
})
