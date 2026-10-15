import { extensionBrowser as browser } from '@/shared/browser'

/** Retired credential namespaces that must never be reused. */
const RETIRED_PAIR_TOKEN_STORAGE_KEYS = [
  'motrix.pairTokens',
  'motrix.pairToken',
]

export interface StorageKeyRemover {
  remove(keys: string | string[]): Promise<void>
}

/**
 * Permanently remove the token-era pairing stores.
 *
 * Values are deliberately neither read nor parsed: no token shape, including
 * an unknown future version, is a valid input to MBP1 credential migration.
 * Repeating the exact remove on every service-worker start is the tombstone;
 * a marker could be left behind while a rolled-back build writes a token back.
 *
 * Service-worker startup invokes this on every wake before endpoint
 * autostart. It is intentionally not a data migration: retired secrets are
 * only deleted, never decoded or copied into MBP1 state.
 */
export async function purgeRetiredPairTokenStorage(
  storage: StorageKeyRemover = browser.storage.local
): Promise<void> {
  await storage.remove([...RETIRED_PAIR_TOKEN_STORAGE_KEYS])
}

/** Durable startup barrier shared by message dispatch and endpoint autostart.
 * Only storage recovery belongs here: discovery, socket authentication and
 * initialize can take seconds (or fail) without making the extension unusable.
 * The caller starts the connection separately after this promise resolves. */
export async function recoverStorageBeforeEndpointAutostart(
  deps: {
    recoverPendingEndpointCleanup: () => Promise<void>
  },
  storage: StorageKeyRemover = browser.storage.local
): Promise<void> {
  await purgeRetiredPairTokenStorage(storage)
  await deps.recoverPendingEndpointCleanup()
}
