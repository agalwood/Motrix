/* eslint quote-props: ["error", "always"] */

/**
 * Map of protocol hosts (e.g. `mo://<host>`) to the internal command
 * dispatched via `sendCommandToAll`.
 *
 * NOTE: Every command listed here can be triggered by any web page that
 * navigates the user to a `mo:`/`motrix:` URL. Only expose commands whose
 * side effects are safe when invoked with attacker-controlled arguments.
 * In particular, do NOT expose commands that read/write the filesystem
 * or open OS resources based on their arguments (e.g. `reveal-in-folder`,
 * which would let a remote page invoke `shell.showItemInFolder` with an
 * arbitrary path).
 */
export default {
  'task-list': 'application:task-list',
  'new-task': 'application:new-task',
  'new-bt-task': 'application:new-bt-task',
  'pause-all-task': 'application:pause-all-task',
  'resume-all-task': 'application:resume-all-task',
  'preferences': 'application:preferences',
  'about': 'application:about'
}

/**
 * Allowlist of query-string keys that may be forwarded as arguments for
 * each protocol command. Any keys not listed here are dropped before the
 * command is dispatched. This prevents a crafted `mo:` URL from smuggling
 * unexpected fields (e.g. arbitrary task options, prototype-polluting
 * keys, etc.) into internal command handlers.
 */
export const protocolArgsAllowlist = {
  'task-list': ['status'],
  'new-task': ['uri'],
  'new-bt-task': [],
  'pause-all-task': [],
  'resume-all-task': [],
  'preferences': [],
  'about': []
}
