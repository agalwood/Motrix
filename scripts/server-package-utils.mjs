import { builtinModules } from 'node:module'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const CONTRACT_KEYS = [
  'buildInputs',
  'resourceInputs',
  'runtimeRoots',
  'schemaVersion',
  'supportedTargets',
]
const BUILD_INPUT_KEYS = [
  'destination',
  'entry',
  'scanExternals',
  'source',
  'type',
]
const RESOURCE_INPUT_KEYS = ['destination', 'source', 'type']
const BUDGET_KEYS = [
  'artifactBytes',
  'betterSqlite3Prebuilds',
  'dependencyBytes',
  'foreignNativeBinaries',
  'packageInstances',
  'schemaVersion',
  'unexpectedRuntimeRoots',
  'unresolvedExternals',
]
const SUPPORTED_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64-gnu',
  'linux-arm64-musl',
  'linux-x64-gnu',
  'linux-x64-musl',
  'win32-x64',
]
const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32'])
const SUPPORTED_ARCHES = new Set(['arm64', 'x64'])
const SUPPORTED_LIBCS = new Set(['gnu', 'musl'])
const BUILTIN_MODULES = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])

function assertRecord(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort()
  if (isDeepStrictEqual(actual, [...expected].sort())) return
  const unknown = actual.filter((key) => !expected.includes(key))
  const missing = expected.filter((key) => !actual.includes(key))
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown key: ${unknown.join(', ')}`)
  }
  throw new Error(`${label} is missing key: ${missing.join(', ')}`)
}

function assertInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

function assertSortedUniqueStrings(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string' || entry.length === 0)
  ) {
    throw new Error(`${label} must be an array of non-empty strings`)
  }
  const normalized = [...new Set(value)].sort()
  if (!isDeepStrictEqual(value, normalized)) {
    throw new Error(`${label} must contain unique strings in sorted order`)
  }
  return value
}

export function normalizeRelativePath(value, label = 'path') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'))
  if (
    path.posix.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`${label} must stay within its root: ${value}`)
  }
  return normalized.replace(/^\.\//, '')
}

function validateInputList(value, keys, label, withEntry) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`)
  }
  const sources = []
  const destinations = new Set()
  for (const [index, rawInput] of value.entries()) {
    const input = assertRecord(rawInput, `${label}[${index}]`)
    assertExactKeys(input, keys, `${label}[${index}]`)
    input.source = normalizeRelativePath(
      input.source,
      `${label}[${index}].source`
    )
    input.destination = normalizeRelativePath(
      input.destination,
      `${label}[${index}].destination`
    )
    if (!['directory', 'file'].includes(input.type)) {
      throw new Error(`${label}[${index}].type must be directory or file`)
    }
    if (destinations.has(input.destination)) {
      throw new Error(
        `${label} has duplicate destination: ${input.destination}`
      )
    }
    destinations.add(input.destination)
    sources.push(input.source)
    if (withEntry) {
      if (input.type === 'directory') {
        const entries = Array.isArray(input.entry)
          ? input.entry.map((entry, entryIndex) =>
              normalizeRelativePath(
                entry,
                `${label}[${index}].entry[${entryIndex}]`
              )
            )
          : [normalizeRelativePath(input.entry, `${label}[${index}].entry`)]
        if (
          entries.length === 0 ||
          !isDeepStrictEqual(entries, [...new Set(entries)].sort())
        ) {
          throw new Error(
            `${label}[${index}].entry must contain unique paths in sorted order`
          )
        }
        if (Array.isArray(input.entry)) input.entry = entries
        else input.entry = entries[0]
      } else if (input.entry !== null) {
        throw new Error(`${label}[${index}].entry must be null for a file`)
      }
      if (typeof input.scanExternals !== 'boolean') {
        throw new Error(`${label}[${index}].scanExternals must be a boolean`)
      }
    }
  }
  if (!isDeepStrictEqual(sources, [...sources].sort())) {
    throw new Error(`${label} must be sorted by source`)
  }
  return value
}

export function validateServerRuntimeContract(value) {
  const contract = assertRecord(value, 'server runtime contract')
  assertExactKeys(contract, CONTRACT_KEYS, 'server runtime contract')
  if (contract.schemaVersion !== 1) {
    throw new Error('server runtime contract schemaVersion must be 1')
  }
  assertSortedUniqueStrings(contract.supportedTargets, 'supportedTargets')
  if (!isDeepStrictEqual(contract.supportedTargets, SUPPORTED_TARGETS)) {
    throw new Error(
      `supportedTargets must be exactly: ${SUPPORTED_TARGETS.join(', ')}`
    )
  }
  assertSortedUniqueStrings(contract.runtimeRoots, 'runtimeRoots')
  validateInputList(contract.buildInputs, BUILD_INPUT_KEYS, 'buildInputs', true)
  validateInputList(
    contract.resourceInputs,
    RESOURCE_INPUT_KEYS,
    'resourceInputs',
    false
  )
  const destinations = [
    ...contract.buildInputs.map((input) => input.destination),
    ...contract.resourceInputs.map((input) => input.destination),
  ]
  if (new Set(destinations).size !== destinations.length) {
    throw new Error('server runtime contract has duplicate input destinations')
  }
  return contract
}

export function validateServerSizeBudgets(value) {
  const budgets = assertRecord(value, 'server size budgets')
  assertExactKeys(budgets, BUDGET_KEYS, 'server size budgets')
  if (budgets.schemaVersion !== 1) {
    throw new Error('server size budgets schemaVersion must be 1')
  }
  for (const key of BUDGET_KEYS.filter((entry) => entry !== 'schemaVersion')) {
    assertInteger(budgets[key], `server size budgets.${key}`)
  }
  if (budgets.betterSqlite3Prebuilds !== 1) {
    throw new Error('server size budgets.betterSqlite3Prebuilds must be 1')
  }
  return budgets
}

function inferLinuxLibc() {
  const report = process.report?.getReport?.()
  return report?.header?.glibcVersionRuntime ? 'gnu' : 'musl'
}

export function serverTargetKey(platform, arch, libc) {
  return platform === 'linux'
    ? `${platform}-${arch}-${libc}`
    : `${platform}-${arch}`
}

export function betterSqlite3PrebuildName(target) {
  if (!target || typeof target !== 'object') {
    throw new Error('Server package target is required')
  }
  if (target.platform === 'linux') {
    if (
      !SUPPORTED_ARCHES.has(target.arch) ||
      !SUPPORTED_LIBCS.has(target.libc)
    ) {
      throw new Error('invalid Linux target for better-sqlite3')
    }
    const prefix = target.libc === 'musl' ? 'linuxmusl' : 'linux'
    return `${prefix}-${target.arch}.node`
  }
  if (
    !SUPPORTED_PLATFORMS.has(target.platform) ||
    !SUPPORTED_ARCHES.has(target.arch)
  ) {
    throw new Error('invalid target for better-sqlite3')
  }
  return `${target.platform}-${target.arch}.node`
}

export function parseServerTarget(options = {}) {
  const strict = options.strict === true || options.ci === true
  const platform = options.platform ?? (strict ? undefined : process.platform)
  const rawArch = options.arch ?? (strict ? undefined : process.arch)
  const arch = rawArch === 'amd64' ? 'x64' : rawArch

  if (!platform || !rawArch) {
    throw new Error('Server package target requires --platform and --arch')
  }
  if (!SUPPORTED_PLATFORMS.has(platform) || !SUPPORTED_ARCHES.has(arch)) {
    throw new Error(
      `unsupported Server package platform/arch: ${platform}-${arch}`
    )
  }

  let libc = options.libc
  if (platform === 'linux') {
    libc ??= strict ? undefined : inferLinuxLibc()
    if (!libc || !SUPPORTED_LIBCS.has(libc)) {
      throw new Error('Linux Server package target requires --libc gnu or musl')
    }
  } else if (libc !== undefined) {
    throw new Error(`--libc is only valid for Linux Server package targets`)
  }

  const key = serverTargetKey(platform, arch, libc)
  if (!SUPPORTED_TARGETS.includes(key)) {
    throw new Error(
      `unsupported Server package target ${key}; expected one of: ${SUPPORTED_TARGETS.join(', ')}`
    )
  }
  return { platform, arch, ...(libc ? { libc } : {}), key }
}

export function resolveServerInput(input, target) {
  const replacements = {
    arch: target.arch,
    aria2Binary: target.platform === 'win32' ? 'aria2c.exe' : 'aria2c',
    platform: target.platform,
  }
  const resolveTemplate = (value, label) =>
    normalizeRelativePath(
      value.replaceAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, name) => {
        const replacement = replacements[name]
        if (!replacement) {
          throw new Error(`${label} has unknown target token: ${token}`)
        }
        return replacement
      }),
      label
    )

  return {
    ...input,
    source: resolveTemplate(input.source, 'Server input source'),
    destination: resolveTemplate(input.destination, 'Server input destination'),
  }
}

export function packageNameFromSpecifier(specifier) {
  if (
    typeof specifier !== 'string' ||
    specifier.length === 0 ||
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:') ||
    specifier.startsWith('#')
  ) {
    return undefined
  }
  const parts = specifier.split('/')
  if (specifier.startsWith('@')) {
    return parts.length >= 2 && parts[1] ? `${parts[0]}/${parts[1]}` : undefined
  }
  return parts[0] || undefined
}

function readStringToken(source, start) {
  const quote = source[start]
  let value = ''
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index]
    if (character === quote) return { value, end: index + 1 }
    if (character === '\\') {
      index += 1
      if (index >= source.length) return undefined
      value += source[index]
    } else {
      value += character
    }
  }
  return undefined
}

// Keywords after which a `/` starts a regex literal rather than division.
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
])

// Standard lexer heuristic: a `/` is division only when the previous token
// can terminate an operand (identifier, string, `)`, `]`, or a digit —
// numbers tokenize as digit punctuation here). Everything else, including
// the start of input, puts the slash in expression position where it must
// begin a regex literal.
function regexLiteralAllowed(previous) {
  if (!previous) return true
  if (previous.type === 'string') return false
  if (previous.type === 'identifier') {
    return REGEX_PRECEDING_KEYWORDS.has(previous.value)
  }
  return !/[)\]\w.]/.test(previous.value)
}

// Returns the index just past the regex literal (including flags), or -1
// when no well-formed regex starts at `start` (an unescaped newline or EOF
// before the closing slash).
function readRegexEnd(source, start) {
  let index = start + 1
  let inClass = false
  while (index < source.length) {
    const character = source[index]
    if (character === '\\') {
      index += 2
      continue
    }
    if (character === '\n' || character === '\r') return -1
    if (inClass) {
      if (character === ']') inClass = false
    } else if (character === '[') {
      inClass = true
    } else if (character === '/') {
      index += 1
      while (/[a-z]/i.test(source[index] ?? '')) index += 1
      return index
    }
    index += 1
  }
  return -1
}

function tokenizeJavaScript(source) {
  const tokens = []
  let index = 0
  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]
    if (/\s/.test(character)) {
      index += 1
      continue
    }
    if (character === '/' && next === '/') {
      const end = source.indexOf('\n', index + 2)
      index = end === -1 ? source.length : end + 1
      continue
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end === -1 ? source.length : end + 2
      continue
    }
    if (character === '/' && regexLiteralAllowed(tokens[tokens.length - 1])) {
      const end = readRegexEnd(source, index)
      if (end !== -1) {
        index = end
        continue
      }
    }
    if (character === '"' || character === "'" || character === '`') {
      const token = readStringToken(source, index)
      if (!token) break
      tokens.push({ type: 'string', value: token.value })
      index = token.end
      continue
    }
    if (/[A-Za-z_$]/.test(character)) {
      let end = index + 1
      while (/[\w$]/.test(source[end] ?? '')) end += 1
      tokens.push({ type: 'identifier', value: source.slice(index, end) })
      index = end
      continue
    }
    tokens.push({ type: 'punctuation', value: character })
    index += 1
  }
  return tokens
}

export function scanStaticModuleSpecifiers(source) {
  if (typeof source !== 'string') {
    throw new Error('JavaScript source must be a string')
  }
  const tokens = tokenizeJavaScript(source)
  const specifiers = new Set()
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.type !== 'identifier') continue
    if (token.value === 'require' || token.value === 'import') {
      if (
        tokens[index + 1]?.value === '(' &&
        tokens[index + 2]?.type === 'string'
      ) {
        specifiers.add(tokens[index + 2].value)
        continue
      }
    }
    if (token.value !== 'import' && token.value !== 'export') continue
    if (tokens[index + 1]?.type === 'string') {
      specifiers.add(tokens[index + 1].value)
      continue
    }
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const candidate = tokens[cursor]
      if (candidate.value === ';') break
      if (
        candidate.type === 'identifier' &&
        candidate.value === 'from' &&
        tokens[cursor + 1]?.type === 'string'
      ) {
        specifiers.add(tokens[cursor + 1].value)
        break
      }
    }
  }
  return [...specifiers].sort()
}

export function externalPackageRoots(specifiers) {
  const roots = new Set()
  for (const specifier of specifiers) {
    if (BUILTIN_MODULES.has(specifier)) continue
    const root = packageNameFromSpecifier(specifier)
    if (root) roots.add(root)
  }
  return [...roots].sort()
}

export function sortJson(value) {
  if (Array.isArray(value)) return value.map((entry) => sortJson(entry))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])])
    )
  }
  return value
}

export function stringifySortedJson(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`
}

export const serverPackageTargets = Object.freeze({
  arches: [...SUPPORTED_ARCHES].sort(),
  libcs: [...SUPPORTED_LIBCS].sort(),
  platforms: [...SUPPORTED_PLATFORMS].sort(),
  targets: [...SUPPORTED_TARGETS],
})
