import { parseStrictSemVer } from './release-metadata.mjs'

// This identity is only for local test packages, never a Store submission.
export const WINDOWS_STORE_TEST_IDENTITY = Object.freeze({
  name: 'Motrix.Store.Test',
  publisher: 'CN=Motrix Store Test',
  publisherDisplayName: 'Motrix Store Test',
})

// Fixed diagnostic inputs only; none of these fields are caller-configurable.
export const WINDOWS_STORE_NATIVE_MESSAGING_DIAGNOSTIC = Object.freeze({
  mode: 'native-messaging-probe-v1',
  applicationId: 'MotrixNativeHostP0',
  alias: 'motrix-store-p0-native-host.exe',
  executable: 'diagnostics/motrix-store-p0-probe.exe',
  source: 'tests/fixtures/windows-store-native-messaging/stdio-probe.cs',
})

// Also reserve the earlier local packaging prototype's exact identity fields.
// Do not reject unrelated publisher names merely because they contain "Test".
const TEST_IDENTITIES = [
  WINDOWS_STORE_TEST_IDENTITY,
  {
    name: 'Motrix.Store.P0',
    publisher: 'CN=Motrix Store P0 Test',
    publisherDisplayName: 'Motrix P0 Local Test',
  },
]

const METADATA_KEYS = [
  'schemaVersion',
  'profile',
  'architecture',
  'productVersion',
  'packageVersion',
  'source',
  'identity',
  'storeProductId',
  'previousPackageVersions',
  'testDiagnostics',
]
const IDENTITY_KEYS = ['name', 'publisher', 'publisherDisplayName']
const QUAD_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const PACKAGE_NAME = /^[A-Za-z0-9.-]{3,50}$/
const RESERVED_PACKAGE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const UNSAFE_TEXT =
  /[\p{Cc}\p{Cs}\u2028\u2029\u202a-\u202e\u2066-\u2069\ufffe\uffff]/u

function requireRecord(value, label, keys) {
  if (
    value === null ||
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`${label} must be a plain object`)
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) {
      throw new Error(
        `${label} has an unknown field: ${JSON.stringify(String(key))}`
      )
    }
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')) {
      throw new Error(`${label}.${key} must be a data property`)
    }
  }
  return value
}

function requireText(value, label, maximum) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    UNSAFE_TEXT.test(value)
  ) {
    throw new Error(
      `${label} must be nonempty text of at most ${maximum} characters without surrounding whitespace or control characters`
    )
  }
  return value
}

function parsePackageVersion(value, label) {
  requireText(value, label, 23)
  if (!QUAD_VERSION.test(value)) {
    throw new Error(`${label} must contain four canonical decimal integers`)
  }
  const components = value.split('.').map(Number)
  if (components.some((component) => component > 65535)) {
    throw new Error(`${label} components must be between 0 and 65535`)
  }
  return components
}

/** Compare the complete unsigned 16-bit version tuple, including Store revisions. */
export function compareWindowsPackageVersions(left, right) {
  const a = parsePackageVersion(left, 'left package version')
  const b = parsePackageVersion(right, 'right package version')
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return 0
}

function validateIdentity(value, profile) {
  const input = requireRecord(value, 'identity', IDENTITY_KEYS)
  const name = requireText(input.name, 'identity.name', 50)
  // Package-string restrictions, including reserved Windows device names:
  // https://learn.microsoft.com/windows/apps/desktop/modernize/package-identity-overview
  if (
    !PACKAGE_NAME.test(name) ||
    RESERVED_PACKAGE_NAME.test(name) ||
    name.endsWith('.') ||
    /(?:^|\.)xn--/i.test(name)
  ) {
    throw new Error('identity.name must be a valid Windows package name')
  }
  const publisher = requireText(input.publisher, 'identity.publisher', 8192)
  // This project consumes literal CN-based subjects from external metadata.
  // Full X.509 parsing and certificate-subject matching remain SDK/signing checks.
  const commonName = publisher.slice(3).split(/[,;+]/, 1)[0].trim()
  if (!publisher.startsWith('CN=') || !commonName || commonName === '""') {
    throw new Error(
      'identity.publisher must contain a nonempty CN-based subject'
    )
  }
  const publisherDisplayName = requireText(
    input.publisherDisplayName,
    'identity.publisherDisplayName',
    256
  )
  const identity = { name, publisher, publisherDisplayName }
  for (const key of IDENTITY_KEYS) {
    if (
      profile === 'test' &&
      identity[key] !== WINDOWS_STORE_TEST_IDENTITY[key]
    ) {
      throw new Error(
        `test identity.${key} must match WINDOWS_STORE_TEST_IDENTITY`
      )
    }
    if (
      profile === 'store' &&
      TEST_IDENTITIES.some(
        (testIdentity) =>
          identity[key].toLowerCase() === testIdentity[key].toLowerCase()
      )
    ) {
      throw new Error(`store identity.${key} must not use the test identity`)
    }
  }
  return Object.freeze(identity)
}

/**
 * Validate supplied metadata without IO, environment variables, Git, or credentials.
 * Success is not authority to publish. Partner Center identity, protected tag/main
 * ancestry, payload provenance, and complete published history need external evidence.
 * Manifest identities must retain the exact case, spacing, and punctuation supplied:
 * https://learn.microsoft.com/windows/apps/publish/view-app-identity-details
 */
export function validateWindowsStoreMetadata(value) {
  const input = requireRecord(value, 'metadata', METADATA_KEYS)
  if (input.schemaVersion !== 1) throw new Error('schemaVersion must be 1')
  if (input.profile !== 'test' && input.profile !== 'store') {
    throw new Error('profile must be test or store')
  }
  if (input.architecture !== 'x64') throw new Error('architecture must be x64')

  let testDiagnostics
  if (Object.hasOwn(input, 'testDiagnostics')) {
    if (input.profile !== 'test') {
      throw new Error('testDiagnostics is only allowed for the test profile')
    }
    if (
      input.testDiagnostics !== WINDOWS_STORE_NATIVE_MESSAGING_DIAGNOSTIC.mode
    ) {
      throw new Error(
        'testDiagnostics must be native-messaging-probe-v1 when present'
      )
    }
    testDiagnostics = input.testDiagnostics
  }

  const productVersion = requireText(
    input.productVersion,
    'productVersion',
    256
  )
  const product = parseStrictSemVer(productVersion, 'productVersion')
  if (
    input.profile === 'store' &&
    (product.prerelease || productVersion.includes('+'))
  ) {
    throw new Error(
      'store productVersion must be stable SemVer without build metadata'
    )
  }
  const packageVersion = requireText(input.packageVersion, 'packageVersion', 23)
  const components = parsePackageVersion(packageVersion, 'packageVersion')
  // Generic package identity permits 0.0.0.0. Store submissions impose stricter
  // first/fourth-component rules; packageVersion is never derived from productVersion.
  // https://learn.microsoft.com/windows/apps/publish/publish-your-app/msix/app-package-requirements
  if (
    input.profile === 'store' &&
    (components[0] === 0 || components[3] !== 0)
  ) {
    throw new Error(
      'store packageVersion must have a nonzero major and a zero fourth component'
    )
  }

  const sourceInput = requireRecord(input.source, 'source', ['commit', 'tag'])
  const commit = requireText(sourceInput.commit, 'source.commit', 40)
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(
      'source.commit must be a full lowercase 40-character hexadecimal SHA'
    )
  }
  const source = { commit }
  if (Object.hasOwn(sourceInput, 'tag') || input.profile === 'store') {
    const tag = requireText(sourceInput.tag, 'source.tag', 257)
    if (tag !== `v${productVersion}`) {
      throw new Error('source.tag must exactly match v<productVersion>')
    }
    source.tag = tag
  }

  const identity = validateIdentity(input.identity, input.profile)
  let storeProductId
  if (Object.hasOwn(input, 'storeProductId')) {
    if (input.profile !== 'store') {
      throw new Error('storeProductId is not allowed for the test profile')
    }
    storeProductId = requireText(input.storeProductId, 'storeProductId', 64)
    // An opaque identifier, not proof that a Store listing exists. The length
    // bound is a project input limit, not a claim about all Store ID formats.
    if (!/^[A-Za-z0-9]+$/.test(storeProductId)) {
      throw new Error('storeProductId must be an alphanumeric identifier')
    }
  }

  const history = Object.hasOwn(input, 'previousPackageVersions')
    ? input.previousPackageVersions
    : []
  if (!Array.isArray(history)) {
    throw new Error('previousPackageVersions must be an array')
  }
  let highestSuppliedPackageVersion = null
  const previousPackageVersions = Array.from(history, (previous, index) => {
    parsePackageVersion(previous, `previousPackageVersions[${index}]`)
    // This is this project's monotonic release policy, not a general restriction
    // on Microsoft's multi-device submissions. Store-assigned revisions count.
    if (compareWindowsPackageVersions(packageVersion, previous) <= 0) {
      throw new Error(
        `packageVersion must be greater than previousPackageVersions[${index}]`
      )
    }
    if (
      highestSuppliedPackageVersion === null ||
      compareWindowsPackageVersions(previous, highestSuppliedPackageVersion) > 0
    ) {
      highestSuppliedPackageVersion = previous
    }
    return previous
  })

  return Object.freeze({
    metadata: Object.freeze({
      schemaVersion: 1,
      profile: input.profile,
      architecture: input.architecture,
      productVersion,
      packageVersion,
      source: Object.freeze(source),
      identity,
      ...(storeProductId === undefined ? {} : { storeProductId }),
      previousPackageVersions: Object.freeze(previousPackageVersions),
      ...(testDiagnostics === undefined ? {} : { testDiagnostics }),
    }),
    validation: Object.freeze({
      scope: 'syntax-and-supplied-history-only',
      highestSuppliedPackageVersion,
      suppliedVersionCount: previousPackageVersions.length,
      partnerCenterIdentityVerified: false,
      publisherSubjectVerified: false,
      protectedTagVerified: false,
      sourceCommitVerified: false,
      publishedVersionHistoryVerified: false,
    }),
  })
}
