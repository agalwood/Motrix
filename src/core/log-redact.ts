import { basename } from 'node:path'

export type LogRedactionContext =
  | { profile: 'application' }
  | { profile: 'plugin'; verbose: boolean }

const REDACTED = '[redacted]'
const REDACTED_PATH = '[redacted-path]'
const UNREADABLE = '[unreadable]'
const CIRCULAR = '[circular]'
const MAX_DEPTH_REACHED = '[max-depth]'
const FUNCTION_VALUE = '[function]'
const UNKNOWN_OBJECT = '[redacted-object]'
const MAX_DEPTH = 8
const MAX_RECORD_FIELDS = 256
const MAX_ARRAY_ITEMS = 256
const MAX_STRUCTURED_STRING_CHARS = 16 * 1024
const MAX_ERROR_NAME_CHARS = 256
const MAX_ERROR_STACK_CHARS = 64 * 1024
const MAX_FIELD_NAME_CHARS = 256
const MAX_PARSEABLE_LOCATION_CHARS = 64 * 1024
const STORAGE_KEY_MAX_CHARS = 32
const HEADER_NAME_MAX_CHARS = 128
const TRUNCATED_FIELDS_KEY = 'redactionTruncatedFields'
const OMIT = Symbol('omit-log-field')

const ROOT_LOG_FIELD_RENAMES = new Map([
  ['level', 'fieldLevel'],
  ['time', 'fieldTime'],
  ['msg', 'fieldMsg'],
  ['pid', 'fieldPid'],
  ['hostname', 'fieldHostname'],
  ['module', 'fieldModule'],
])

const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

const LOG_URL_KEYS = new Set([
  'url',
  'uri',
  'sourceurl',
  'videourl',
  'audiourl',
])

const LOG_URL_COLLECTION_KEYS = new Set(['urls', 'uris', 'rewrittenuris'])

const PROXY_KEYS = new Set([
  'proxy',
  'proxyurl',
  'allproxy',
  'httpproxy',
  'httpsproxy',
])

const SENSITIVE_VALUE_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'cookies',
  'setcookie',
  'setcookies',
  'password',
  'passwd',
  'passphrase',
  'userpassword',
  'secret',
  'clientsecret',
  'apisecret',
  'secretkey',
  'secretaccesskey',
  'privatekey',
  'credential',
  'credentials',
  'rpcsecret',
  'token',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'idtoken',
  'csrftoken',
  'bearertoken',
  'localtoken',
  'apikey',
  'proxyauth',
  'mutualkey',
  'mutualkeyb64',
  'ticketkey',
  'nmticket',
  'pairnonce',
  'proxyusername',
  'proxypassword',
  'allproxyuser',
  'allproxypasswd',
  'httpuser',
  'httppasswd',
  'ftpuser',
  'ftppasswd',
])

const COMMON_DROP_KEYS = new Set(['body', 'storagevalue'])
const PLUGIN_PATH_KEYS = new Set(['path', 'filepath'])
const SENSITIVE_PATH_KEYS = new Set([
  'cookiejar',
  'cookiejarpath',
  'loadcookies',
])

const SAFE_ENGINE_OPTION_KEYS = new Set([
  'selectfile',
  'maxdownloadlimit',
  'maxuploadlimit',
  'seedratio',
])

interface RedactionState {
  readonly context: LogRedactionContext
  readonly seen: WeakSet<object>
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function outputKey(
  key: string,
  depth: number,
  profile: LogRedactionContext['profile']
): string {
  if (depth !== 0) return key
  if (profile === 'plugin' && key === 'ts') return 'fieldTs'
  return ROOT_LOG_FIELD_RENAMES.get(key) ?? key
}

function boundedOutputKey(
  key: string,
  depth: number,
  index: number,
  profile: LogRedactionContext['profile']
): string {
  return key.length > MAX_FIELD_NAME_CHARS
    ? `fieldKeyTruncated${index}`
    : outputKey(key, depth, profile)
}

function uniqueOutputKey(
  target: Record<string, unknown>,
  desiredKey: string
): string {
  if (!Object.hasOwn(target, desiredKey)) return desiredKey
  for (let suffix = 2; suffix <= MAX_RECORD_FIELDS + 2; suffix += 1) {
    const suffixText = `${suffix}`
    const candidate = `${desiredKey.slice(
      0,
      MAX_FIELD_NAME_CHARS - suffixText.length
    )}${suffixText}`
    if (!Object.hasOwn(target, candidate)) return candidate
  }
  return 'fieldNameCollision'
}

function setOwnField(
  target: Record<string, unknown>,
  key: string,
  value: unknown
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  })
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  let suffix = ''
  let prefixChars = maxChars
  for (let attempt = 0; attempt < 3; attempt += 1) {
    prefixChars = Math.max(0, maxChars - suffix.length)
    suffix = `…[truncated:${value.length - prefixChars} chars]`
  }
  prefixChars = Math.max(0, maxChars - suffix.length)
  return `${value.slice(0, prefixChars)}${suffix}`
}

export function truncateLogText(value: string): string {
  return truncateText(value, MAX_STRUCTURED_STRING_CHARS)
}

function truncationMarker(count: number, unit: string): string {
  return `[truncated:${count} ${unit}]`
}

function headerTruncationMarker(count: number): string {
  return `Motrix-Redaction-Truncated-${count}-Headers`
}

function boundedArrayItems<T>(values: readonly T[]): readonly T[] {
  const limit =
    values.length > MAX_ARRAY_ITEMS ? MAX_ARRAY_ITEMS - 1 : values.length
  return values.slice(0, limit)
}

function boundedRecordKeys(keys: readonly string[]): readonly string[] {
  const limit =
    keys.length > MAX_RECORD_FIELDS ? MAX_RECORD_FIELDS - 1 : keys.length
  return keys.slice(0, limit)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  try {
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
  } catch {
    return false
  }
}

function safeBasename(raw: unknown): string {
  if (typeof raw !== 'string') return '[unparseable-path]'
  if (raw.length > MAX_PARSEABLE_LOCATION_CHARS) return '[unparseable-path]'
  return truncateText(
    basename(raw.replaceAll('\\', '/')),
    MAX_STRUCTURED_STRING_CHARS
  )
}

function redactUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '[unparseable-url]'
  if (raw.length > MAX_PARSEABLE_LOCATION_CHARS) return '[unparseable-url]'
  try {
    const url = new URL(raw)
    const protocol = url.protocol.toLowerCase()
    if (
      protocol === 'http:' ||
      protocol === 'https:' ||
      protocol === 'ftp:' ||
      protocol === 'sftp:' ||
      protocol === 'ws:' ||
      protocol === 'wss:'
    ) {
      return truncateText(
        `${protocol}//${url.host}${url.pathname}`,
        MAX_STRUCTURED_STRING_CHARS
      )
    }
    if (protocol === 'file:') {
      return truncateText(
        `file:${safeBasename(url.pathname)}`,
        MAX_STRUCTURED_STRING_CHARS
      )
    }
    return truncateText(`${protocol}<redacted>`, MAX_STRUCTURED_STRING_CHARS)
  } catch {
    return '[unparseable-url]'
  }
}

function redactCollectionValue(raw: unknown): unknown {
  if (Array.isArray(raw)) {
    const selected = boundedArrayItems(raw)
    const out = selected.map(redactUrl)
    if (raw.length > MAX_ARRAY_ITEMS) {
      out.push(truncationMarker(raw.length - selected.length, 'items'))
    }
    return out
  }
  if (typeof raw === 'boolean' || typeof raw === 'number') return raw
  if (typeof raw !== 'string') return '[unparseable-url]'
  if (raw.length > MAX_PARSEABLE_LOCATION_CHARS) return '[unparseable-url]'
  try {
    new URL(raw)
    return redactUrl(raw)
  } catch {
    // A scalar under a collection-shaped key can be provenance metadata,
    // for example contributors.uris = "plugin-rewriter". Preserve that
    // diagnostic instead of treating the key name alone as proof of a URL.
    return truncateText(raw, MAX_STRUCTURED_STRING_CHARS)
  }
}

function redactProxy(raw: unknown): string {
  if (typeof raw !== 'string') return '[unparseable-proxy]'
  if (raw.length > MAX_PARSEABLE_LOCATION_CHARS) return '[unparseable-proxy]'
  try {
    const url = new URL(raw)
    return truncateText(
      `${url.protocol}//${url.host}`,
      MAX_STRUCTURED_STRING_CHARS
    )
  } catch {
    return '[unparseable-proxy]'
  }
}

function redactStorageKey(raw: unknown): unknown {
  if (typeof raw !== 'string') return REDACTED
  if (raw.length <= STORAGE_KEY_MAX_CHARS) return raw
  return `${raw.slice(0, STORAGE_KEY_MAX_CHARS)}…`
}

function validHeaderName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  if (raw.length > HEADER_NAME_MAX_CHARS) return undefined
  const name = raw.trim()
  if (
    name.length === 0 ||
    name.length > HEADER_NAME_MAX_CHARS ||
    !HEADER_NAME_PATTERN.test(name)
  ) {
    return undefined
  }
  return name
}

function headerNames(raw: unknown): string[] {
  if (isPlainObject(raw)) {
    try {
      const keys = Object.keys(raw)
      const selected = boundedArrayItems(keys)
      const names = selected.flatMap((key) => {
        const name = validHeaderName(key)
        return name ? [name] : []
      })
      if (keys.length > MAX_ARRAY_ITEMS) {
        names.push(headerTruncationMarker(keys.length - selected.length))
      }
      return names
    } catch {
      return []
    }
  }
  const allValues = Array.isArray(raw) ? raw : [raw]
  const values = boundedArrayItems(allValues)
  const names: string[] = []
  for (const value of values) {
    if (typeof value === 'string') {
      const separator = value.indexOf(':')
      const name =
        separator > 0
          ? validHeaderName(value.slice(0, separator))
          : validHeaderName(value)
      if (name) names.push(name)
      continue
    }
    if (isPlainObject(value)) {
      try {
        const name = validHeaderName(value.name)
        if (name) names.push(name)
      } catch {
        // Ignore a hostile getter rather than leaking the original value.
      }
    }
  }
  if (allValues.length > MAX_ARRAY_ITEMS) {
    names.push(headerTruncationMarker(allValues.length - values.length))
  }
  return names
}

function binarySummary(value: ArrayBuffer | ArrayBufferView): string {
  return `[binary:${value.byteLength} bytes]`
}

function redactError(
  error: Error,
  state: RedactionState,
  depth: number
): Error | string {
  if (state.seen.has(error)) return CIRCULAR
  state.seen.add(error)
  try {
    let name: string
    let message: string
    let stack: string | undefined
    try {
      name = truncateText(error.name, MAX_ERROR_NAME_CHARS)
    } catch {
      name = UNREADABLE
    }
    try {
      message = truncateText(error.message, MAX_STRUCTURED_STRING_CHARS)
    } catch {
      message = UNREADABLE
    }

    try {
      stack = error.stack
        ? truncateText(error.stack, MAX_ERROR_STACK_CHARS)
        : undefined
    } catch {
      stack = UNREADABLE
    }

    const out = new Error(message)
    Object.defineProperties(out, {
      name: {
        value: name,
        enumerable: true,
        configurable: true,
        writable: true,
      },
      message: {
        value: message,
        enumerable: true,
        configurable: true,
        writable: true,
      },
    })
    if (stack === undefined) {
      delete out.stack
    } else {
      Object.defineProperty(out, 'stack', {
        value: stack,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }

    let keys: string[]
    try {
      keys = Object.keys(error)
    } catch {
      return out
    }
    const outFields = out as unknown as Record<string, unknown>
    const selectedKeys = boundedRecordKeys(keys)
    for (const [index, key] of selectedKeys.entries()) {
      if (key === 'name' || key === 'message' || key === 'stack') continue
      const safeKey = uniqueOutputKey(
        outFields,
        boundedOutputKey(key, depth, index, state.context.profile)
      )
      if (key.length > MAX_FIELD_NAME_CHARS) {
        setOwnField(outFields, safeKey, REDACTED)
        continue
      }
      let value: unknown
      try {
        value = (error as unknown as Record<string, unknown>)[key]
      } catch {
        setOwnField(outFields, safeKey, UNREADABLE)
        continue
      }
      const redacted = redactValue(value, key, state, depth + 1)
      if (redacted !== OMIT) setOwnField(outFields, safeKey, redacted)
    }
    if (keys.length > MAX_RECORD_FIELDS) {
      setOwnField(
        outFields,
        TRUNCATED_FIELDS_KEY,
        keys.length - selectedKeys.length
      )
    }

    if (!selectedKeys.includes('cause')) {
      try {
        if (Object.hasOwn(error, 'cause')) {
          const cause = (error as Error & { cause?: unknown }).cause
          const redacted = redactValue(cause, 'cause', state, depth + 1)
          if (redacted !== OMIT) setOwnField(outFields, 'cause', redacted)
        }
      } catch {
        setOwnField(outFields, 'cause', UNREADABLE)
      }
    }
    return out
  } finally {
    state.seen.delete(error)
  }
}

function redactExtraEngineOptions(value: unknown): unknown {
  if (!isPlainObject(value)) return REDACTED
  const out: Record<string, unknown> = {}
  let keys: string[]
  try {
    keys = Object.keys(value)
  } catch {
    return REDACTED
  }
  const selectedKeys = boundedRecordKeys(keys)
  for (const [index, key] of selectedKeys.entries()) {
    const safeKey = uniqueOutputKey(
      out,
      boundedOutputKey(key, 1, index, 'application')
    )
    if (key.length > MAX_FIELD_NAME_CHARS) {
      setOwnField(out, safeKey, REDACTED)
      continue
    }
    const normalized = normalizeKey(key)
    let optionValue: unknown
    try {
      optionValue = value[key]
    } catch {
      setOwnField(out, safeKey, UNREADABLE)
      continue
    }
    if (normalized === 'referer') {
      setOwnField(out, safeKey, redactUrl(optionValue))
    } else if (SENSITIVE_PATH_KEYS.has(normalized)) {
      setOwnField(out, safeKey, REDACTED_PATH)
    } else if (SENSITIVE_VALUE_KEYS.has(normalized)) {
      setOwnField(out, safeKey, REDACTED)
    } else if (SAFE_ENGINE_OPTION_KEYS.has(normalized)) {
      const safe =
        optionValue === null ||
        optionValue === undefined ||
        typeof optionValue === 'string' ||
        typeof optionValue === 'number' ||
        typeof optionValue === 'boolean'
          ? optionValue
          : REDACTED
      setOwnField(
        out,
        safeKey,
        typeof safe === 'string'
          ? truncateText(safe, MAX_STRUCTURED_STRING_CHARS)
          : safe
      )
    } else {
      setOwnField(out, safeKey, REDACTED)
    }
  }
  if (keys.length > MAX_RECORD_FIELDS) {
    setOwnField(out, TRUNCATED_FIELDS_KEY, keys.length - selectedKeys.length)
  }
  return out
}

function redactArray(
  values: readonly unknown[],
  key: string,
  state: RedactionState,
  depth: number
): unknown[] | string {
  if (state.seen.has(values)) return CIRCULAR
  state.seen.add(values)
  try {
    const selected = boundedArrayItems(values)
    const out = selected.map((value) => {
      const redacted = redactValue(value, key, state, depth + 1)
      return redacted === OMIT ? REDACTED : redacted
    })
    if (values.length > MAX_ARRAY_ITEMS) {
      out.push(truncationMarker(values.length - selected.length, 'items'))
    }
    return out
  } finally {
    state.seen.delete(values)
  }
}

function redactRecord(
  fields: Record<string, unknown>,
  state: RedactionState,
  depth: number
): Record<string, unknown> | string {
  if (state.seen.has(fields)) return CIRCULAR
  state.seen.add(fields)
  try {
    const out: Record<string, unknown> = {}
    let keys: string[]
    try {
      keys = Object.keys(fields)
    } catch {
      return { redactionFailed: true }
    }
    const selectedKeys = boundedRecordKeys(keys)
    for (const [index, key] of selectedKeys.entries()) {
      const safeKey = uniqueOutputKey(
        out,
        boundedOutputKey(key, depth, index, state.context.profile)
      )
      if (key.length > MAX_FIELD_NAME_CHARS) {
        setOwnField(out, safeKey, REDACTED)
        continue
      }
      let value: unknown
      try {
        value = fields[key]
      } catch {
        setOwnField(out, safeKey, UNREADABLE)
        continue
      }
      const redacted = redactValue(value, key, state, depth + 1)
      if (redacted !== OMIT) setOwnField(out, safeKey, redacted)
    }
    if (keys.length > MAX_RECORD_FIELDS) {
      setOwnField(out, TRUNCATED_FIELDS_KEY, keys.length - selectedKeys.length)
    }
    return out
  } finally {
    state.seen.delete(fields)
  }
}

function redactValue(
  value: unknown,
  key: string,
  state: RedactionState,
  depth: number
): unknown | typeof OMIT {
  if (depth > MAX_DEPTH) return MAX_DEPTH_REACHED

  const normalized = normalizeKey(key)
  if (COMMON_DROP_KEYS.has(normalized)) return OMIT
  if (value === null || value === undefined) return value
  if (normalized === 'headers') {
    if (typeof value === 'boolean' || typeof value === 'number') return value
    return state.context.profile === 'plugin' ? OMIT : headerNames(value)
  }
  if (normalized === 'extraengineoptions') {
    return redactExtraEngineOptions(value)
  }
  if (SENSITIVE_VALUE_KEYS.has(normalized)) return REDACTED
  if (SENSITIVE_PATH_KEYS.has(normalized)) return REDACTED_PATH
  if (LOG_URL_KEYS.has(normalized)) return redactUrl(value)
  if (LOG_URL_COLLECTION_KEYS.has(normalized)) {
    return redactCollectionValue(value)
  }
  if (PROXY_KEYS.has(normalized)) {
    if (typeof value === 'boolean' || typeof value === 'number') return value
    return redactProxy(value)
  }
  if (normalized === 'storagekey') return redactStorageKey(value)
  if (state.context.profile === 'plugin' && PLUGIN_PATH_KEYS.has(normalized)) {
    return safeBasename(value)
  }

  if (typeof value === 'function') return FUNCTION_VALUE
  if (value instanceof Error) return redactError(value, state, depth)
  if (value instanceof Date) {
    try {
      return Date.prototype.toISOString.call(value)
    } catch {
      return UNKNOWN_OBJECT
    }
  }
  if (value instanceof URL) {
    try {
      return redactUrl(URL.prototype.toString.call(value))
    } catch {
      return UNKNOWN_OBJECT
    }
  }
  if (value instanceof ArrayBuffer) return binarySummary(value)
  if (ArrayBuffer.isView(value)) return binarySummary(value)
  if (Array.isArray(value)) return redactArray(value, '', state, depth)
  if (isPlainObject(value)) return redactRecord(value, state, depth)
  if (value !== null && typeof value === 'object') return UNKNOWN_OBJECT
  if (typeof value === 'string') {
    return truncateText(value, MAX_STRUCTURED_STRING_CHARS)
  }
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'symbol') {
    return value.description
      ? `[symbol:${truncateText(value.description, MAX_ERROR_NAME_CHARS)}]`
      : '[symbol]'
  }
  return value
}

function limitVerboseArray(
  values: readonly unknown[],
  seen: WeakSet<object>,
  depth: number
): unknown[] | string {
  if (seen.has(values)) return CIRCULAR
  seen.add(values)
  try {
    const selected = boundedArrayItems(values)
    const out = selected.map((value) =>
      limitVerboseValue(value, seen, depth + 1)
    )
    if (values.length > MAX_ARRAY_ITEMS) {
      out.push(truncationMarker(values.length - selected.length, 'items'))
    }
    return out
  } finally {
    seen.delete(values)
  }
}

function limitVerboseError(
  error: Error,
  seen: WeakSet<object>,
  depth: number
): Error | string {
  if (seen.has(error)) return CIRCULAR
  seen.add(error)
  try {
    let name = UNREADABLE
    let message = UNREADABLE
    let stack: string | undefined
    try {
      name = truncateText(error.name, MAX_ERROR_NAME_CHARS)
    } catch {
      // Keep the sentinel.
    }
    try {
      message = truncateText(error.message, MAX_STRUCTURED_STRING_CHARS)
    } catch {
      // Keep the sentinel.
    }
    try {
      stack = error.stack
        ? truncateText(error.stack, MAX_ERROR_STACK_CHARS)
        : undefined
    } catch {
      stack = UNREADABLE
    }

    const out = new Error(message)
    Object.defineProperties(out, {
      name: {
        value: name,
        enumerable: true,
        configurable: true,
        writable: true,
      },
      message: {
        value: message,
        enumerable: true,
        configurable: true,
        writable: true,
      },
    })
    if (stack === undefined) {
      delete out.stack
    } else {
      Object.defineProperty(out, 'stack', {
        value: stack,
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }

    let keys: string[]
    try {
      keys = Object.keys(error)
    } catch {
      return out
    }
    const outFields = out as unknown as Record<string, unknown>
    const selectedKeys = boundedRecordKeys(keys)
    for (const [index, key] of selectedKeys.entries()) {
      if (key === 'name' || key === 'message' || key === 'stack') continue
      const safeKey = uniqueOutputKey(
        outFields,
        boundedOutputKey(key, depth, index, 'plugin')
      )
      if (key.length > MAX_FIELD_NAME_CHARS) {
        setOwnField(outFields, safeKey, REDACTED)
        continue
      }
      let value: unknown
      try {
        value = (error as unknown as Record<string, unknown>)[key]
      } catch {
        value = UNREADABLE
      }
      setOwnField(outFields, safeKey, limitVerboseValue(value, seen, depth + 1))
    }
    if (keys.length > MAX_RECORD_FIELDS) {
      setOwnField(
        outFields,
        TRUNCATED_FIELDS_KEY,
        keys.length - selectedKeys.length
      )
    }
    if (!selectedKeys.includes('cause')) {
      try {
        if (Object.hasOwn(error, 'cause')) {
          setOwnField(
            outFields,
            'cause',
            limitVerboseValue(
              (error as Error & { cause?: unknown }).cause,
              seen,
              depth + 1
            )
          )
        }
      } catch {
        setOwnField(outFields, 'cause', UNREADABLE)
      }
    }
    return out
  } finally {
    seen.delete(error)
  }
}

function limitVerboseRecord(
  fields: Record<string, unknown>,
  seen: WeakSet<object>,
  depth: number
): Record<string, unknown> | string {
  if (seen.has(fields)) return CIRCULAR
  seen.add(fields)
  try {
    const out: Record<string, unknown> = {}
    let keys: string[]
    try {
      keys = Object.keys(fields)
    } catch {
      return { redactionFailed: true }
    }
    const selectedKeys = boundedRecordKeys(keys)
    for (const [index, key] of selectedKeys.entries()) {
      const safeKey = uniqueOutputKey(
        out,
        boundedOutputKey(key, depth, index, 'plugin')
      )
      if (key.length > MAX_FIELD_NAME_CHARS) {
        setOwnField(out, safeKey, REDACTED)
        continue
      }
      let value: unknown
      try {
        value = fields[key]
      } catch {
        value = UNREADABLE
      }
      setOwnField(out, safeKey, limitVerboseValue(value, seen, depth + 1))
    }
    if (keys.length > MAX_RECORD_FIELDS) {
      setOwnField(out, TRUNCATED_FIELDS_KEY, keys.length - selectedKeys.length)
    }
    return out
  } finally {
    seen.delete(fields)
  }
}

function limitVerboseValue(
  value: unknown,
  seen: WeakSet<object>,
  depth: number
): unknown {
  if (depth > MAX_DEPTH) return MAX_DEPTH_REACHED
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    return truncateText(value, MAX_STRUCTURED_STRING_CHARS)
  }
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'symbol') {
    return value.description
      ? `[symbol:${truncateText(value.description, MAX_ERROR_NAME_CHARS)}]`
      : '[symbol]'
  }
  if (typeof value === 'function') return FUNCTION_VALUE
  if (value instanceof Error) return limitVerboseError(value, seen, depth)
  if (value instanceof Date) {
    try {
      return Date.prototype.toISOString.call(value)
    } catch {
      return UNKNOWN_OBJECT
    }
  }
  if (value instanceof URL) {
    try {
      return truncateText(
        URL.prototype.toString.call(value),
        MAX_STRUCTURED_STRING_CHARS
      )
    } catch {
      return UNKNOWN_OBJECT
    }
  }
  if (value instanceof ArrayBuffer) return binarySummary(value)
  if (ArrayBuffer.isView(value)) return binarySummary(value)
  if (Array.isArray(value)) return limitVerboseArray(value, seen, depth)
  if (isPlainObject(value)) return limitVerboseRecord(value, seen, depth)
  if (typeof value === 'object') return UNKNOWN_OBJECT
  return value
}

function protectVerboseRootFields(
  fields: Record<string, unknown>
): Record<string, unknown> {
  try {
    const limited = limitVerboseRecord(fields, new WeakSet(), 0)
    return typeof limited === 'string' ? { redactionFailed: true } : limited
  } catch {
    return { redactionFailed: true }
  }
}

/**
 * Redacts structured log fields without mutating the input. Application logs
 * retain safe diagnostics; plugin logs keep their existing stricter privacy
 * boundary and may opt into the already-visible per-plugin verbose mode.
 */
export function redactLogFields(
  fields: Record<string, unknown>,
  context: LogRedactionContext
): Record<string, unknown> {
  try {
    if (context.profile === 'plugin' && context.verbose) {
      return protectVerboseRootFields(fields)
    }
    const redacted = redactRecord(fields, { context, seen: new WeakSet() }, 0)
    return typeof redacted === 'string' ? { redactionFailed: true } : redacted
  } catch {
    return { redactionFailed: true }
  }
}

function redactApplicationArgument(value: unknown): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  try {
    const redacted = redactValue(
      value,
      '',
      { context: { profile: 'application' }, seen: new WeakSet() },
      0
    )
    return redacted === OMIT ? REDACTED : redacted
  } catch {
    return { redactionFailed: true }
  }
}

/** Preserve Pino string overloads and primitive formatting values while
 * sanitizing every object argument, including direct Errors and `%j` data. */
export function redactApplicationLogArguments(
  args: readonly unknown[]
): unknown[] {
  return args.map(redactApplicationArgument)
}
