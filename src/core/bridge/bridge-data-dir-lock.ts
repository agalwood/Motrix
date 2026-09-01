import { randomBytes } from 'node:crypto'
import { type BigIntStats, constants } from 'node:fs'
import fs, { type FileHandle } from 'node:fs/promises'
import path from 'node:path'

const LOCK_DOCUMENT_VERSION = 1
const OWNER_NONCE_BYTES = 32
const OWNER_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const MAX_LOCK_DOCUMENT_BYTES = 256
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0
const LOCK_MODE = 0o600

export const BRIDGE_DATA_DIR_LOCK_FILE_NAME = '.motrix-bridge.lock'
const RECOVERY_GUARD_FILE_NAME = '.motrix-bridge.lock.recovery'

export const BRIDGE_DATA_DIR_LOCK_UNAVAILABLE =
  'bridge data directory lock unavailable'

/**
 * Node has no portable advisory file-lock primitive. Fresh create-exclusive
 * locking works on every supported platform, while automatic stale recovery
 * is intentionally unavailable where final-component no-follow semantics
 * cannot be established. In particular, Windows fails closed on a residue;
 * it requests 0600 at creation but relies on the data directory's Windows ACL
 * because POSIX permission bits have no equivalent enforcement there.
 */
export const BRIDGE_DATA_DIR_LOCK_RECOVERY_MODE =
  process.platform !== 'win32' && NO_FOLLOW !== 0
    ? 'external-single-instance-authority'
    : 'unavailable-fail-closed'

const lockHandleBrand: unique symbol = Symbol('BridgeDataDirLockHandle')

export interface BridgeDataDirLockHandle {
  readonly [lockHandleBrand]: true
  /** Idempotent across repeated and concurrent shutdown paths. */
  release(): Promise<void>
}

/**
 * Trusted composition-root authority for stale recovery.
 *
 * This assertion MUST return true only while Motrix Main already owns
 * Electron's `requestSingleInstanceLock()` result, acquired before bridge
 * startup. PID checks, file age, mtime, and heartbeat expiry are not adequate
 * substitutes. Core deliberately cannot manufacture this OS-level proof.
 */
export interface BridgeDataDirLockRecoveryAuthority {
  /**
   * A fresh random value created once for this successful OS single-instance
   * ownership session. All callers in that Main session must share it; a new
   * process ownership session must use a new value.
   */
  readonly ownershipEpoch: string
  assertExclusiveProcessOwnership(): boolean | Promise<boolean>
}

export interface BridgeDataDirLockAcquireOptions {
  readonly recoverExisting?: BridgeDataDirLockRecoveryAuthority
}

interface LockDocument {
  readonly version: typeof LOCK_DOCUMENT_VERSION
  readonly ownerNonce: string
  readonly ownershipEpoch: string | null
}

interface RecoveryGuardDocument {
  readonly version: typeof LOCK_DOCUMENT_VERSION
  readonly recoveryNonce: string
  readonly ownershipEpoch: string
}

interface FileIdentity {
  readonly device: bigint
  readonly inode: bigint
}

interface OwnedFile {
  readonly path: string
  readonly identity: FileIdentity
  readonly expected: Buffer
  handle: FileHandle | null
}

interface ObservedLock {
  readonly identity: FileIdentity
  readonly document: LockDocument
}

interface ObservedRecoveryGuard {
  readonly identity: FileIdentity
  readonly document: RecoveryGuardDocument
}

interface ObservedLockWithLinks extends ObservedLock {
  readonly links: bigint
}

class ExistingLockError extends Error {}
class InternalLockError extends Error {}
class RetainModuleClaimError extends Error {}

interface ProcessClaimRegistry {
  readonly version: 1
  readonly claims: Map<string, symbol>
}

const PROCESS_CLAIM_REGISTRY_KEY = Symbol.for(
  'motrix.bridge.data-dir-lock.process-claims.v1'
)

/**
 * `Symbol.for` + a non-replaceable global slot makes duplicate ESM URLs and
 * duplicate bundles in the same JavaScript realm share the live-path guard.
 * The file's O_EXCL remains the cross-process arbiter.
 */
function processClaimRegistry(): Map<string, symbol> | null {
  try {
    const root = globalThis as typeof globalThis & {
      [PROCESS_CLAIM_REGISTRY_KEY]?: unknown
    }
    const existing = root[PROCESS_CLAIM_REGISTRY_KEY]
    if (existing !== undefined) {
      if (
        typeof existing !== 'object' ||
        existing === null ||
        (existing as Partial<ProcessClaimRegistry>).version !== 1 ||
        !((existing as Partial<ProcessClaimRegistry>).claims instanceof Map)
      ) {
        return null
      }
      return (existing as ProcessClaimRegistry).claims
    }

    const created: ProcessClaimRegistry = Object.freeze({
      version: 1,
      claims: new Map<string, symbol>(),
    })
    Object.defineProperty(root, PROCESS_CLAIM_REGISTRY_KEY, {
      configurable: false,
      enumerable: false,
      value: created,
      writable: false,
    })
    return created.claims
  } catch {
    return null
  }
}

const moduleClaims = processClaimRegistry()
const activeLockHandles = new WeakMap<
  object,
  {
    readonly owned: OwnedFile
    readonly claim: symbol
    readonly claims: Map<string, symbol>
  }
>()

class FileBridgeDataDirLockHandle implements BridgeDataDirLockHandle {
  readonly [lockHandleBrand] = true as const
  private releasePromise: Promise<void> | null = null
  private released = false

  constructor(
    private readonly owned: OwnedFile,
    private readonly claim: symbol,
    private readonly claims: Map<string, symbol>
  ) {
    activeLockHandles.set(this, { owned, claim, claims })
  }

  release(): Promise<void> {
    if (this.released) return Promise.resolve()
    if (this.releasePromise !== null) return this.releasePromise

    this.releasePromise = this.releaseOnce()
      .then(() => {
        this.released = true
        activeLockHandles.delete(this)
      })
      .catch(() => {
        throw publicFailure()
      })
      .finally(() => {
        this.releasePromise = null
      })
    return this.releasePromise
  }

  private async releaseOnce(): Promise<void> {
    if (this.claims.get(this.owned.path) !== this.claim) {
      throw new InternalLockError()
    }
    await removeOwnedFile(this.owned)
    if (this.claims.get(this.owned.path) !== this.claim) {
      throw new InternalLockError()
    }
    this.claims.delete(this.owned.path)
  }
}

/**
 * Execute one trusted startup repair only while `handle` still owns the exact
 * data-directory lock file. The WeakMap claim makes copied or structurally
 * forged handles unusable; the on-disk identity/bytes check catches path
 * replacement before the repair begins.
 */
export async function withBridgeDataDirLock<T>(
  handle: BridgeDataDirLockHandle,
  dataDirectory: string,
  operation: () => Promise<T>
): Promise<T> {
  const active = activeLockHandles.get(handle)
  try {
    if (active === undefined) throw new InternalLockError()
    const canonicalDirectory = await canonicalDataDirectory(dataDirectory)
    if (
      path.dirname(active.owned.path) !== canonicalDirectory ||
      active.claims.get(active.owned.path) !== active.claim
    ) {
      throw new InternalLockError()
    }
    const raw = await readOwnedFile(active.owned, 1n)
    if (!raw.equals(active.owned.expected)) throw new InternalLockError()
  } catch {
    throw publicFailure()
  }
  return operation()
}

/**
 * Acquires the bridge data-directory lock before any bridge store or listener
 * is opened. An existing entry is unavailable by default, including a crash
 * residue. Recovery is a separate, explicit operation authorized only by the
 * process-wide OS ownership assertion documented above.
 */
export async function acquireBridgeDataDirLock(
  dataDirectory: string,
  options: BridgeDataDirLockAcquireOptions = {}
): Promise<BridgeDataDirLockHandle> {
  let lockPath: string | null = null
  let claim: symbol | null = null
  const claims = moduleClaims
  try {
    if (claims === null) throw new InternalLockError()
    const canonicalDirectory = await canonicalDataDirectory(dataDirectory)
    lockPath = path.join(canonicalDirectory, BRIDGE_DATA_DIR_LOCK_FILE_NAME)
    const recoveryGuardPath = path.join(
      canonicalDirectory,
      RECOVERY_GUARD_FILE_NAME
    )

    if (claims.has(lockPath)) throw new ExistingLockError()
    claim = Symbol('bridge-data-dir-lock-claim')
    claims.set(lockPath, claim)

    let owned: OwnedFile
    if (await pathExists(recoveryGuardPath)) {
      owned = await resumeInterruptedRecovery(
        lockPath,
        recoveryGuardPath,
        options.recoverExisting
      )
    } else {
      try {
        owned = await createLockFile(
          lockPath,
          declaredOwnershipEpoch(options.recoverExisting)
        )
        try {
          await assertMissing(recoveryGuardPath)
        } catch (error) {
          try {
            await removeOwnedFile(owned)
          } catch {
            throw new RetainModuleClaimError()
          }
          throw error
        }
      } catch (error) {
        if (!(error instanceof ExistingLockError)) throw error
        owned = await recoverExistingLock(
          lockPath,
          recoveryGuardPath,
          options.recoverExisting
        )
      }
    }

    return new FileBridgeDataDirLockHandle(owned, claim, claims)
  } catch (error) {
    if (
      lockPath !== null &&
      claim !== null &&
      claims?.get(lockPath) === claim &&
      !(error instanceof RetainModuleClaimError)
    ) {
      claims.delete(lockPath)
    }
    throw publicFailure()
  }
}

async function recoverExistingLock(
  lockPath: string,
  recoveryGuardPath: string,
  authority: BridgeDataDirLockRecoveryAuthority | undefined
): Promise<OwnedFile> {
  const ownershipEpoch = await validateRecoveryAuthority(authority)

  const observed = await readExistingLock(lockPath, 1n)
  if (observed.document.ownershipEpoch === ownershipEpoch) {
    throw new ExistingLockError()
  }
  const recoveryNonce = ownerNonce()
  const guard = await createOwnedFile(
    recoveryGuardPath,
    serializeRecoveryGuard({
      version: LOCK_DOCUMENT_VERSION,
      recoveryNonce,
      ownershipEpoch,
    })
  )
  const quarantinePath = `${lockPath}.stale-${recoveryNonce}`
  let quarantineCreated = false
  let originalUnlinked = false
  let replacement: OwnedFile | null = null
  try {
    const current = await readExistingLock(lockPath, 1n)
    if (!sameObservedLock(observed, current)) throw new InternalLockError()

    await fs.link(lockPath, quarantinePath)
    quarantineCreated = true
    const quarantined = await readExistingLock(quarantinePath, 2n)
    if (!sameObservedLock(observed, quarantined)) throw new InternalLockError()
    const stillCurrent = await readExistingLock(lockPath, 2n)
    if (!sameObservedLock(observed, stillCurrent)) throw new InternalLockError()

    await fs.unlink(lockPath)
    originalUnlinked = true
    await syncDirectory(path.dirname(lockPath))
    replacement = await createLockFile(lockPath, ownershipEpoch)

    await removeObservedPath(quarantinePath, observed.identity, 1n)
    quarantineCreated = false
    await removeOwnedFile(guard)
    await syncDirectory(path.dirname(lockPath))
    return replacement
  } catch (error) {
    let cleanupFailed = false
    if (replacement !== null) {
      try {
        await removeOwnedFile(replacement)
      } catch {
        cleanupFailed = true
      }
    }
    if (quarantineCreated) {
      try {
        await removeObservedPath(
          quarantinePath,
          observed.identity,
          originalUnlinked ? 1n : 2n
        )
      } catch {
        cleanupFailed = true
      }
    }
    try {
      await removeOwnedFile(guard)
    } catch {
      cleanupFailed = true
    }
    if (cleanupFailed) throw new RetainModuleClaimError()
    throw error
  }
}

async function resumeInterruptedRecovery(
  lockPath: string,
  recoveryGuardPath: string,
  authority: BridgeDataDirLockRecoveryAuthority | undefined
): Promise<OwnedFile> {
  const ownershipEpoch = await validateRecoveryAuthority(authority)
  const guard = await readRecoveryGuard(recoveryGuardPath)
  if (guard.document.ownershipEpoch === ownershipEpoch) {
    throw new ExistingLockError()
  }

  const quarantinePath = `${lockPath}.stale-${guard.document.recoveryNonce}`
  const [current, quarantined] = await Promise.all([
    readOptionalLock(lockPath),
    readOptionalLock(quarantinePath),
  ])

  if (
    current !== null &&
    quarantined !== null &&
    sameIdentity(current.identity, quarantined.identity)
  ) {
    if (current.links !== 2n || quarantined.links !== 2n) {
      throw new InternalLockError()
    }
    await removeObservedPath(lockPath, current.identity, 2n)
    await removeObservedPath(quarantinePath, quarantined.identity, 1n)
  } else {
    if (current !== null) {
      if (current.links !== 1n) throw new InternalLockError()
      await removeObservedPath(lockPath, current.identity, 1n)
    }
    if (quarantined !== null) {
      if (quarantined.links !== 1n) throw new InternalLockError()
      await removeObservedPath(quarantinePath, quarantined.identity, 1n)
    }
  }

  const stillGuard = await readRecoveryGuard(recoveryGuardPath)
  if (!sameRecoveryGuard(guard, stillGuard)) throw new InternalLockError()
  await removeObservedPath(recoveryGuardPath, guard.identity, 1n)
  await syncDirectoryBestEffort(path.dirname(lockPath))
  return createFreshDuringRecovery(lockPath, recoveryGuardPath, ownershipEpoch)
}

async function createFreshDuringRecovery(
  lockPath: string,
  recoveryGuardPath: string,
  ownershipEpoch: string
): Promise<OwnedFile> {
  const guard = await createOwnedFile(
    recoveryGuardPath,
    serializeRecoveryGuard({
      version: LOCK_DOCUMENT_VERSION,
      recoveryNonce: ownerNonce(),
      ownershipEpoch,
    })
  )
  let replacement: OwnedFile | null = null
  try {
    await assertMissing(lockPath)
    replacement = await createLockFile(lockPath, ownershipEpoch)
    await removeOwnedFile(guard)
    return replacement
  } catch (error) {
    let cleanupFailed = false
    if (replacement !== null) {
      try {
        await removeOwnedFile(replacement)
      } catch {
        cleanupFailed = true
      }
    }
    try {
      await removeOwnedFile(guard)
    } catch {
      cleanupFailed = true
    }
    if (cleanupFailed) throw new RetainModuleClaimError()
    throw error
  }
}

async function validateRecoveryAuthority(
  authority: BridgeDataDirLockRecoveryAuthority | undefined
): Promise<string> {
  if (
    BRIDGE_DATA_DIR_LOCK_RECOVERY_MODE !==
      'external-single-instance-authority' ||
    authority === undefined
  ) {
    throw new ExistingLockError()
  }
  const ownershipEpoch = declaredOwnershipEpoch(authority)
  if (ownershipEpoch === null) throw new ExistingLockError()

  let authorized = false
  try {
    authorized = (await authority.assertExclusiveProcessOwnership()) === true
  } catch {
    throw new InternalLockError()
  }
  if (!authorized) throw new ExistingLockError()
  return ownershipEpoch
}

function declaredOwnershipEpoch(
  authority: BridgeDataDirLockRecoveryAuthority | undefined
): string | null {
  if (authority === undefined) return null
  if (!OWNER_NONCE_PATTERN.test(authority.ownershipEpoch)) {
    throw new InternalLockError()
  }
  return authority.ownershipEpoch
}

async function canonicalDataDirectory(dataDirectory: string): Promise<string> {
  if (
    typeof dataDirectory !== 'string' ||
    dataDirectory.length === 0 ||
    dataDirectory.includes('\0')
  ) {
    throw new InternalLockError()
  }
  const canonical = await fs.realpath(dataDirectory)
  const metadata = await fs.stat(canonical)
  if (!metadata.isDirectory()) throw new InternalLockError()
  return canonical
}

async function createLockFile(
  lockPath: string,
  ownershipEpoch: string | null
): Promise<OwnedFile> {
  const document: LockDocument = {
    version: LOCK_DOCUMENT_VERSION,
    ownerNonce: ownerNonce(),
    ownershipEpoch,
  }
  return createOwnedFile(lockPath, serializeDocument(document))
}

async function createOwnedFile(
  filePath: string,
  content: Buffer
): Promise<OwnedFile> {
  if (
    content.byteLength === 0 ||
    content.byteLength > MAX_LOCK_DOCUMENT_BYTES
  ) {
    throw new InternalLockError()
  }

  let handle: FileHandle
  try {
    handle = await fs.open(
      filePath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      LOCK_MODE
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ExistingLockError()
    }
    throw error
  }

  let owned: OwnedFile | null = null
  let createdIdentity: FileIdentity | undefined
  try {
    if (process.platform !== 'win32') await handle.chmod(LOCK_MODE)
    const metadata = await handle.stat({ bigint: true })
    if (metadata.isFile() && metadata.ino !== 0n) {
      createdIdentity = identityOf(metadata)
    }
    validateLockMetadata(metadata, 1n, false)
    owned = {
      path: filePath,
      identity: identityOf(metadata),
      expected: content,
      handle,
    }
    await handle.writeFile(content)
    await handle.sync()
    const written = await readOwnedFile(owned, 1n)
    if (!written.equals(content)) throw new InternalLockError()
    await syncDirectory(path.dirname(filePath))
    return owned
  } catch (error) {
    if (createdIdentity === undefined) {
      try {
        const metadata = await handle.stat({ bigint: true })
        if (metadata.isFile() && metadata.ino !== 0n) {
          createdIdentity = identityOf(metadata)
        }
      } catch {
        // An unidentifiable create result is retained fail-closed below.
      }
    }
    let closeFailed = false
    try {
      await handle.close()
    } catch {
      closeFailed = true
    }
    if (owned !== null) owned.handle = null
    let removeFailed = false
    try {
      await removePathIfIdentityMatches(filePath, createdIdentity)
    } catch {
      removeFailed = true
    }
    if (closeFailed || createdIdentity === undefined || removeFailed) {
      throw new RetainModuleClaimError()
    }
    throw error
  }
}

async function readExistingLock(
  filePath: string,
  expectedLinks: bigint
): Promise<ObservedLock> {
  if (
    BRIDGE_DATA_DIR_LOCK_RECOVERY_MODE !== 'external-single-instance-authority'
  ) {
    throw new InternalLockError()
  }
  const before = await fs.lstat(filePath, { bigint: true })
  validateLockMetadata(before, expectedLinks, true)

  const handle = await fs.open(filePath, constants.O_RDONLY | NO_FOLLOW)
  try {
    const opened = await handle.stat({ bigint: true })
    validateLockMetadata(opened, expectedLinks, true)
    if (!sameIdentity(identityOf(before), identityOf(opened))) {
      throw new InternalLockError()
    }
    const raw = await readBounded(handle, opened)
    return {
      identity: identityOf(opened),
      document: parseLockDocument(raw),
    }
  } finally {
    await handle.close()
  }
}

async function readRecoveryGuard(
  filePath: string
): Promise<ObservedRecoveryGuard> {
  if (
    BRIDGE_DATA_DIR_LOCK_RECOVERY_MODE !== 'external-single-instance-authority'
  ) {
    throw new InternalLockError()
  }
  const before = await fs.lstat(filePath, { bigint: true })
  validateLockMetadata(before, 1n, true)

  const handle = await fs.open(filePath, constants.O_RDONLY | NO_FOLLOW)
  try {
    const opened = await handle.stat({ bigint: true })
    validateLockMetadata(opened, 1n, true)
    if (!sameIdentity(identityOf(before), identityOf(opened))) {
      throw new InternalLockError()
    }
    return {
      identity: identityOf(opened),
      document: parseRecoveryGuard(await readBounded(handle, opened)),
    }
  } finally {
    await handle.close()
  }
}

async function readOptionalLock(
  filePath: string
): Promise<ObservedLockWithLinks | null> {
  let metadata: BigIntStats
  try {
    metadata = await fs.lstat(filePath, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (metadata.nlink !== 1n && metadata.nlink !== 2n) {
    throw new InternalLockError()
  }
  const observed = await readExistingLock(filePath, metadata.nlink)
  return { ...observed, links: metadata.nlink }
}

async function readOwnedFile(
  owned: OwnedFile,
  expectedLinks: bigint
): Promise<Buffer> {
  const handle = owned.handle
  if (handle === null) throw new InternalLockError()
  const metadata = await handle.stat({ bigint: true })
  validateLockMetadata(metadata, expectedLinks, false)
  if (!sameIdentity(owned.identity, identityOf(metadata))) {
    throw new InternalLockError()
  }
  return readBounded(handle, metadata)
}

async function readBounded(
  handle: FileHandle,
  metadata: BigIntStats
): Promise<Buffer> {
  const size = Number(metadata.size)
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_LOCK_DOCUMENT_BYTES
  ) {
    throw new InternalLockError()
  }
  const result = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < result.byteLength) {
    const { bytesRead } = await handle.read(
      result,
      offset,
      result.byteLength - offset,
      offset
    )
    if (bytesRead === 0) throw new InternalLockError()
    offset += bytesRead
  }
  const after = await handle.stat({ bigint: true })
  if (after.size !== metadata.size) throw new InternalLockError()
  return result
}

async function removeOwnedFile(owned: OwnedFile): Promise<void> {
  if (owned.handle !== null) {
    const raw = await readOwnedFile(owned, 1n)
    if (!raw.equals(owned.expected)) throw new InternalLockError()
    const atPath = await fs.lstat(owned.path, { bigint: true })
    validateLockMetadata(atPath, 1n, false)
    if (!sameIdentity(owned.identity, identityOf(atPath))) {
      throw new InternalLockError()
    }
    await owned.handle.close()
    owned.handle = null
  }

  const current = await fs.lstat(owned.path, { bigint: true })
  validateLockMetadata(current, 1n, false)
  if (!sameIdentity(owned.identity, identityOf(current))) {
    throw new InternalLockError()
  }
  await fs.unlink(owned.path)
  await syncDirectoryBestEffort(path.dirname(owned.path))
}

async function removeObservedPath(
  filePath: string,
  identity: FileIdentity,
  expectedLinks: bigint
): Promise<void> {
  const metadata = await fs.lstat(filePath, { bigint: true })
  validateLockMetadata(metadata, expectedLinks, false)
  if (!sameIdentity(identity, identityOf(metadata))) {
    throw new InternalLockError()
  }
  await fs.unlink(filePath)
}

async function removePathIfIdentityMatches(
  filePath: string,
  identity: FileIdentity | undefined
): Promise<void> {
  if (identity === undefined) return
  const metadata = await fs.lstat(filePath, { bigint: true })
  if (sameIdentity(identity, identityOf(metadata))) await fs.unlink(filePath)
}

function validateLockMetadata(
  metadata: BigIntStats,
  expectedLinks: bigint,
  requireSecureExistingOpen: boolean
): void {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.ino === 0n ||
    metadata.nlink !== expectedLinks ||
    metadata.size < 0n ||
    metadata.size > BigInt(MAX_LOCK_DOCUMENT_BYTES) ||
    (process.platform !== 'win32' &&
      (metadata.mode & 0o777n) !== BigInt(LOCK_MODE)) ||
    (requireSecureExistingOpen && NO_FOLLOW === 0)
  ) {
    throw new InternalLockError()
  }
}

function identityOf(metadata: BigIntStats): FileIdentity {
  return { device: metadata.dev, inode: metadata.ino }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode
}

function sameObservedLock(left: ObservedLock, right: ObservedLock): boolean {
  return (
    sameIdentity(left.identity, right.identity) &&
    left.document.version === right.document.version &&
    left.document.ownerNonce === right.document.ownerNonce &&
    left.document.ownershipEpoch === right.document.ownershipEpoch
  )
}

function sameRecoveryGuard(
  left: ObservedRecoveryGuard,
  right: ObservedRecoveryGuard
): boolean {
  return (
    sameIdentity(left.identity, right.identity) &&
    left.document.version === right.document.version &&
    left.document.recoveryNonce === right.document.recoveryNonce &&
    left.document.ownershipEpoch === right.document.ownershipEpoch
  )
}

function parseLockDocument(raw: Buffer): LockDocument {
  let value: unknown
  try {
    value = JSON.parse(raw.toString('utf-8'))
  } catch {
    throw new InternalLockError()
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !hasExactKeys(value as Record<string, unknown>, [
      'ownerNonce',
      'ownershipEpoch',
      'version',
    ])
  ) {
    throw new InternalLockError()
  }
  const candidate = value as Record<string, unknown>
  if (
    candidate.version !== LOCK_DOCUMENT_VERSION ||
    typeof candidate.ownerNonce !== 'string' ||
    !OWNER_NONCE_PATTERN.test(candidate.ownerNonce) ||
    (candidate.ownershipEpoch !== null &&
      (typeof candidate.ownershipEpoch !== 'string' ||
        !OWNER_NONCE_PATTERN.test(candidate.ownershipEpoch)))
  ) {
    throw new InternalLockError()
  }
  return {
    version: LOCK_DOCUMENT_VERSION,
    ownerNonce: candidate.ownerNonce,
    ownershipEpoch: candidate.ownershipEpoch as string | null,
  }
}

function parseRecoveryGuard(raw: Buffer): RecoveryGuardDocument {
  let value: unknown
  try {
    value = JSON.parse(raw.toString('utf-8'))
  } catch {
    throw new InternalLockError()
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !hasExactKeys(value as Record<string, unknown>, [
      'ownershipEpoch',
      'recoveryNonce',
      'version',
    ])
  ) {
    throw new InternalLockError()
  }
  const candidate = value as Record<string, unknown>
  if (
    candidate.version !== LOCK_DOCUMENT_VERSION ||
    typeof candidate.recoveryNonce !== 'string' ||
    !OWNER_NONCE_PATTERN.test(candidate.recoveryNonce) ||
    typeof candidate.ownershipEpoch !== 'string' ||
    !OWNER_NONCE_PATTERN.test(candidate.ownershipEpoch)
  ) {
    throw new InternalLockError()
  }
  return {
    version: LOCK_DOCUMENT_VERSION,
    recoveryNonce: candidate.recoveryNonce,
    ownershipEpoch: candidate.ownershipEpoch,
  }
}

function serializeDocument(document: LockDocument): Buffer {
  const serialized = Buffer.from(JSON.stringify(document), 'utf-8')
  if (
    serialized.byteLength === 0 ||
    serialized.byteLength > MAX_LOCK_DOCUMENT_BYTES
  ) {
    throw new InternalLockError()
  }
  return serialized
}

function serializeRecoveryGuard(document: RecoveryGuardDocument): Buffer {
  const serialized = Buffer.from(JSON.stringify(document), 'utf-8')
  if (
    serialized.byteLength === 0 ||
    serialized.byteLength > MAX_LOCK_DOCUMENT_BYTES
  ) {
    throw new InternalLockError()
  }
  return serialized
}

function ownerNonce(): string {
  return randomBytes(OWNER_NONCE_BYTES).toString('base64url')
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return (
    keys.length === wanted.length &&
    keys.every((key, index) => key === wanted[index])
  )
}

async function assertMissing(filePath: string): Promise<void> {
  try {
    await fs.lstat(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  throw new ExistingLockError()
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await fs.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectoryBestEffort(directory: string): Promise<void> {
  try {
    await syncDirectory(directory)
  } catch {
    // Unlink is the ownership commit point. A failed directory fsync may leave
    // a crash residue after power loss, but must not report the live handle as
    // retained after the path is already available to another process.
  }
}

function publicFailure(): Error {
  return new Error(BRIDGE_DATA_DIR_LOCK_UNAVAILABLE)
}
