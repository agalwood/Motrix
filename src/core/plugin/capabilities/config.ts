// Per-plugin config resolver — value resolver + secret decrypt hook + onChange notification.
//
// Each plugin gets its own `ConfigCapabilityHost` instance (constructed via
// the Task 18 factory's `configFor(pluginId)` helper). The host:
//   - `get(key)` resolves: stored value → schema default → undefined.
//     If the key is secret and the stored value is a string, it is decrypted
//     via the injected `decryptSecret` function before being returned.
//   - `getRaw(key)` returns the stored value verbatim — no defaults, no decrypt.
//   - `getAll()` returns a merged map (stored wins over defaults) with secrets
//     decrypted.
//   - `onChange(handler)` lets the plugin VM subscribe to config mutations.
//   - `applyExternalChange(changes)` is called by the Task 22 IPC handler
//     when the renderer updates plugin config; registered handlers fire
//     synchronously. Per-handler errors are caught and swallowed so one
//     bad handler cannot cascade.

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class ConfigError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'ConfigError'
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigChange {
  key: string
  value: unknown
  previous: unknown
}

export type ConfigChangeHandler = (changes: ConfigChange[]) => void

export interface ConfigOptions {
  pluginId: string
  /** Pulls appSettings.plugins[pluginId].config (or empty object). */
  readValues: () => Record<string, unknown>
  /** Collected from manifest contributes.configuration schema defaults. */
  schemaDefaults: Record<string, unknown>
  /** Keys whose manifest schema has secret:true. */
  secretFields: ReadonlySet<string>
  /** Injected by Task 18 factory; absent in environments without a SecretStore. */
  decryptSecret?: (cipher: string) => Promise<string>
}

// ---------------------------------------------------------------------------
// ConfigCapabilityHost
// ---------------------------------------------------------------------------

export class ConfigCapabilityHost {
  private readonly opts: ConfigOptions
  private readonly handlers = new Set<ConfigChangeHandler>()

  constructor(opts: ConfigOptions) {
    this.opts = opts
  }

  /**
   * Returns the resolved value for `key`:
   *   1. Stored value (from readValues) if present.
   *   2. Schema default if no stored value.
   *   3. undefined if neither is present.
   *
   * If the resolved value is a string and the key is secret, it is decrypted
   * via `decryptSecret`. If no decryptSecret is injected for a stored secret
   * string, throws ConfigError('plugin.lifecycle.secrets_seed_missing', ...).
   */
  async get(key: string): Promise<unknown> {
    const stored = this.opts.readValues()
    const storedValue = Object.hasOwn(stored, key) ? stored[key] : undefined

    const resolved =
      storedValue !== undefined ? storedValue : this.opts.schemaDefaults[key]

    // Only decrypt if the resolved value is a string and the key is secret.
    if (
      resolved !== undefined &&
      typeof resolved === 'string' &&
      this.opts.secretFields.has(key)
    ) {
      if (!this.opts.decryptSecret) {
        throw new ConfigError(
          'plugin.lifecycle.secrets_seed_missing',
          `plugin "${this.opts.pluginId}" config key "${key}" is secret but no decryptSecret function was injected`
        )
      }
      return this.opts.decryptSecret(resolved)
    }

    return resolved
  }

  /**
   * Returns the stored value verbatim — does NOT fall back to schema defaults
   * and does NOT decrypt. Intended for the renderer's "is this overridden?" check.
   */
  async getRaw(key: string): Promise<unknown> {
    const stored = this.opts.readValues()
    return Object.hasOwn(stored, key) ? stored[key] : undefined
  }

  /**
   * Returns a merged map of all keys: schema defaults overridden by stored values.
   * Secret fields appear as decrypted plaintext in the result.
   */
  async getAll(): Promise<Record<string, unknown>> {
    const merged: Record<string, unknown> = {
      ...this.opts.schemaDefaults,
      ...this.opts.readValues(),
    }

    // Decrypt any secret fields that hold a string value.
    for (const key of this.opts.secretFields) {
      const val = merged[key]
      if (typeof val === 'string') {
        if (!this.opts.decryptSecret) {
          throw new ConfigError(
            'plugin.lifecycle.secrets_seed_missing',
            `plugin "${this.opts.pluginId}" config key "${key}" is secret but no decryptSecret function was injected`
          )
        }
        merged[key] = await this.opts.decryptSecret(val)
      }
    }

    return merged
  }

  /**
   * Register a change listener. Returns a handle whose `dispose()` removes it.
   */
  onChange(handler: ConfigChangeHandler): { dispose: () => void } {
    this.handlers.add(handler)
    return {
      dispose: () => {
        this.handlers.delete(handler)
      },
    }
  }

  /**
   * Called by the Task 22 IPC handler when the user updates plugin config from
   * the renderer. Fires all registered handlers synchronously; per-handler
   * errors are caught and swallowed so one bad handler cannot block others.
   */
  applyExternalChange(changes: ConfigChange[]): void {
    for (const handler of this.handlers) {
      try {
        handler(changes)
      } catch {
        // Intentionally swallowed — plugin handler errors must not cascade.
      }
    }
  }
}
