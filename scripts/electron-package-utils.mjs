import os from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const RUNTIME_CONTRACT_KEYS = [
  'common',
  'platforms',
  'schemaVersion',
  'supportedTargets',
]
const PLATFORM_CONTRACT_KEYS = ['optional', 'required']
const SIZE_BUDGET_KEYS = [
  'betterSqlite3Bytes',
  'duplicateResvgWasmFiles',
  'foreignBetterSqlite3Prebuilds',
  'payloadBytes',
  'schemaVersion',
  'unexpectedPackageNames',
]
const SUPPORTED_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
]
const SUPPORTED_PLATFORMS = ['darwin', 'linux', 'win32']
const SUPPORTED_ARCHES = ['arm64', 'x64']

function assertRecord(value, label) {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${label} must be an object`)
  }
  return value
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort()
  if (!isDeepStrictEqual(actual, [...expected].sort())) {
    const unknown = actual.filter((key) => !expected.includes(key))
    const missing = expected.filter((key) => !actual.includes(key))
    if (unknown.length > 0) {
      throw new Error(`${label} has unknown key: ${unknown.join(', ')}`)
    }
    throw new Error(`${label} is missing key: ${missing.join(', ')}`)
  }
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
    value.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error(`${label} must be an array of strings`)
  }
  const sorted = [...new Set(value)].sort()
  if (!isDeepStrictEqual(value, sorted)) {
    throw new Error(`${label} must contain unique strings in sorted order`)
  }
  return value
}

export function validateRuntimeDependencyContract(value) {
  const contract = assertRecord(value, 'runtime dependency contract')
  assertExactKeys(
    contract,
    RUNTIME_CONTRACT_KEYS,
    'runtime dependency contract'
  )
  if (contract.schemaVersion !== 1) {
    throw new Error('runtime dependency contract schemaVersion must be 1')
  }

  assertSortedUniqueStrings(contract.supportedTargets, 'supportedTargets')
  if (!isDeepStrictEqual(contract.supportedTargets, SUPPORTED_TARGETS)) {
    throw new Error(
      `supportedTargets must be exactly: ${SUPPORTED_TARGETS.join(', ')}`
    )
  }
  assertSortedUniqueStrings(contract.common, 'common runtime roots')

  const platforms = assertRecord(contract.platforms, 'platforms')
  assertExactKeys(platforms, SUPPORTED_PLATFORMS, 'platforms')
  for (const platform of SUPPORTED_PLATFORMS) {
    const entry = assertRecord(platforms[platform], `platforms.${platform}`)
    assertExactKeys(entry, PLATFORM_CONTRACT_KEYS, `platforms.${platform}`)
    assertSortedUniqueStrings(entry.required, `platforms.${platform}.required`)
    assertSortedUniqueStrings(entry.optional, `platforms.${platform}.optional`)
  }

  return contract
}

export function validateSizeBudgetContract(value) {
  const contract = assertRecord(value, 'size budget contract')
  assertExactKeys(contract, SIZE_BUDGET_KEYS, 'size budget contract')
  if (contract.schemaVersion !== 1) {
    throw new Error('size budget contract schemaVersion must be 1')
  }
  for (const key of SIZE_BUDGET_KEYS.filter(
    (entry) => entry !== 'schemaVersion'
  )) {
    assertInteger(contract[key], `size budget contract.${key}`)
  }
  return contract
}

export function targetKey(platform, arch) {
  return `${platform}-${arch}`
}

export function parseTarget(options = {}) {
  const strict = options.strict === true || options.ci === true
  const platform = options.platform ?? (strict ? undefined : process.platform)
  const arch = options.arch ?? (strict ? undefined : process.arch)

  if (!platform || !arch) {
    throw new Error(
      'Electron package target requires both --platform and --arch'
    )
  }
  const key = targetKey(platform, arch)
  if (!SUPPORTED_TARGETS.includes(key)) {
    throw new Error(
      `unsupported Electron package target ${key}; expected one of: ${SUPPORTED_TARGETS.join(', ')}`
    )
  }
  return { platform, arch, key }
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

export function normalizeRelativePath(value, label = 'path') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  const portable = value.replaceAll('\\', '/')
  const normalized = path.posix.normalize(portable)
  if (
    path.posix.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new Error(`${label} must stay within its root: ${value}`)
  }
  return normalized.replace(/^\.\//, '')
}

export function bytesToMiB(bytes) {
  assertInteger(bytes, 'bytes')
  return bytes / (1024 * 1024)
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

export function sanitizeMachinePaths(value, roots = [os.homedir()]) {
  if (typeof value !== 'string') return value
  return roots
    .filter((root) => typeof root === 'string' && root.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((result, root) => result.replaceAll(root, '<home>'), value)
}

export const electronPackageTargets = Object.freeze({
  arches: [...SUPPORTED_ARCHES],
  platforms: [...SUPPORTED_PLATFORMS],
  targets: [...SUPPORTED_TARGETS],
})
