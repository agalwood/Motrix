// notify capability — plugin-facing desktop notification primitive.
//
// The interface is runtime-agnostic. Concrete implementations live in:
//   - src/main/plugin/notify-electron.ts  (Electron, uses Notification API)
//   - src/server/plugin/notify-stub.ts    (Node/Docker, re-exports UnavailableNotifyHost)
//
// Dedupe: callers may pass opts.id to deduplicate notifications per plugin.
// Calling show({ id: 'x', ... }) twice closes the first notification before
// showing the second. Without an id, each call is independent.

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class NotifyCapabilityError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'NotifyCapabilityError'
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotifyShowOpts {
  /** Dedup key scoped per plugin. */
  id?: string
  title: string
  body: string
  icon?: 'info' | 'success' | 'error'
  urgency?: 'low' | 'normal' | 'critical'
}

export interface NotifyCapabilityHost {
  readonly available: boolean
  show(pluginId: string, opts: NotifyShowOpts): Promise<void>
}

// ---------------------------------------------------------------------------
// UnavailableNotifyHost
// ---------------------------------------------------------------------------

export class UnavailableNotifyHost implements NotifyCapabilityHost {
  readonly available = false

  async show(_pluginId: string, _opts: NotifyShowOpts): Promise<void> {
    throw new NotifyCapabilityError(
      'plugin.capability.unavailable',
      'notify capability is not available in this runtime'
    )
  }
}
