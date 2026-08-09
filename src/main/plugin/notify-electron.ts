// Electron-native notify capability implementation.
//
// Uses Electron's Notification API. Maintains a per-plugin Map keyed by
// `${pluginId}:${opts.id ?? '_'}` for deduplication: calling show() with the
// same id closes the previous notification before showing the new one.

import {
  NotifyCapabilityError,
  type NotifyCapabilityHost,
  type NotifyShowOpts,
} from '@core/plugin/capabilities/notify'
import { Notification } from 'electron'

export class ElectronNotifyHost implements NotifyCapabilityHost {
  readonly available: boolean = Notification.isSupported()

  private readonly active = new Map<string, Notification>()

  async show(pluginId: string, opts: NotifyShowOpts): Promise<void> {
    if (!this.available) {
      throw new NotifyCapabilityError(
        'plugin.capability.unavailable',
        'notify capability is not available in this runtime'
      )
    }

    const key = `${pluginId}:${opts.id ?? '_'}`

    // Close any existing notification with the same dedupe key.
    const prev = this.active.get(key)
    if (prev) {
      prev.close()
    }

    const n = new Notification({
      title: opts.title,
      body: opts.body,
      urgency: opts.urgency,
    })

    n.on('close', () => {
      // Remove from map only if this is still the active entry for the key.
      if (this.active.get(key) === n) {
        this.active.delete(key)
      }
    })

    n.show()
    this.active.set(key, n)
  }
}
