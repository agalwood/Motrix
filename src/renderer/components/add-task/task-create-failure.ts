// Turns a raw CreateTask rejection into something a person can act on.
//
// The IPC layer hands the renderer the AppError message verbatim, wrapped in
// Electron's remote-method envelope. Most messages are already user-facing;
// a plugin-chain abort is not — it names an internal chain and a plugin id,
// and the only useful action (disable that plugin) is nowhere in the text.

/** Strip the IPC envelope and error-class prefix from a rejection. */
export function taskCreateFailureReason(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  const reason = error.message
    .replace(/^Error invoking remote method '[^']+':\s*/u, '')
    .replace(/^(?:AppError|Error):\s*/u, '')
    .trim()
  return reason || null
}

export interface PluginChainAbort {
  pluginId: string
  detail: string
}

const CHAIN_ABORT_PREFIX = 'plugin chain aborted: '

/**
 * Recognize `plugin chain aborted: <pluginId>: <detail>` — the shape
 * HookOrchestrator produces for a fail-closed chain. Returns null when the
 * abort carries no plugin attribution (e.g. a chain-level abort), so the
 * caller falls back to the generic message rather than inventing a plugin id.
 */
export function parsePluginChainAbort(reason: string): PluginChainAbort | null {
  if (!reason.startsWith(CHAIN_ABORT_PREFIX)) return null
  const rest = reason.slice(CHAIN_ABORT_PREFIX.length)
  const separator = rest.indexOf(': ')
  if (separator <= 0) return null
  const pluginId = rest.slice(0, separator).trim()
  const detail = rest.slice(separator + 2).trim()
  if (!pluginId || !detail) return null
  return { pluginId, detail }
}

export interface PathTooLong {
  length: string
  limit: string
  path: string
}

const PATH_TOO_LONG = /^task path too long: (\d+)\/(\d+): (.+)$/su

/**
 * Recognize the pre-create guard from `create-task-handler` — the counterpart
 * of the `DL_PATH_TOO_LONG` terminal error, raised before the task exists.
 * Electron flattens AppError to its message across IPC, so the code travels
 * inside the text, the same way a plugin chain abort does.
 */
export function parsePathTooLong(reason: string): PathTooLong | null {
  const match = PATH_TOO_LONG.exec(reason)
  if (!match) return null
  return { length: match[1]!, limit: match[2]!, path: match[3]! }
}
