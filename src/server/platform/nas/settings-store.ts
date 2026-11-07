import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import path from 'node:path'
import {
  type NasPackageSettings,
  type NasSettingsResult,
  type NasSettingsView,
  nasPackageSettingsSchema,
  saveNasSettingsSchema,
} from '@shared/schemas/nas-settings'
import writeFileAtomic from 'write-file-atomic'

const MAX_BYTES = 32 * 1024
// Up to 64 package-generated device/inode pairs may accompany the public settings.
const MAX_PRIVATE_BYTES = MAX_BYTES + 4 * 1024
type GrantValidation =
  | boolean
  | 'folderUnavailable'
  | { directoryIdentities: string[] }
export async function readNasConfigurationText(
  file: string,
  optional = false
): Promise<string | null> {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  ).catch((error: NodeJS.ErrnoException) => {
    if (optional && error.code === 'ENOENT') return null
    throw error
  })
  if (!handle) return null
  try {
    const info = await handle.stat()
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > MAX_PRIVATE_BYTES
    )
      throw new Error('Untrusted NAS configuration')
    const buffer = Buffer.alloc(MAX_PRIVATE_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const part = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead
      )
      if (!part.bytesRead) break
      bytesRead += part.bytesRead
    }
    if (bytesRead > MAX_PRIVATE_BYTES)
      throw new Error('NAS configuration too large')
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/** A pending document is a restart journal: lifecycle applies it only after
 * the old server/engine have stopped. Active grants never change under open IO. */
export class NasSettingsStore {
  private transition: Promise<void> = Promise.resolve()
  private active?: NasPackageSettings
  constructor(
    private readonly directory: string,
    private readonly platform: NasSettingsView['platform'],
    private readonly validationTimeoutMs = 20_000
  ) {}

  private async snapshot() {
    const [packageText, rootsText, pendingText] = await Promise.all([
      readNasConfigurationText(
        path.join(this.directory, 'package-settings.json')
      ),
      readNasConfigurationText(path.join(this.directory, 'directories.json')),
      readNasConfigurationText(
        path.join(this.directory, 'pending-settings.json'),
        true
      ),
    ])
    // DSM's directory fingerprints are package-private and must never be
    // supplied by an operator's form or included in the public settings view.
    const unpack = (text: string) => {
      const raw = JSON.parse(text)
      if (this.platform !== 'synology')
        return { settings: raw, identities: undefined }
      const { directoryIdentities, ...settings } = raw
      return { settings, identities: directoryIdentities }
    }
    const grants = unpack(rootsText ?? '')
    const applied = nasPackageSettingsSchema.parse({
      ...JSON.parse(packageText ?? ''),
      ...grants.settings,
    })
    const pending = pendingText === null ? null : unpack(pendingText)
    const settings =
      pending === null
        ? applied
        : nasPackageSettingsSchema.parse(pending.settings)
    const pinnedRoots = new Map<string, string>()
    for (const entry of [grants, pending]) {
      if (!entry || entry.identities === undefined) continue
      if (
        !Array.isArray(entry.identities) ||
        entry.identities.length !== entry.settings.roots.length
      )
        throw new Error('Invalid NAS directory identities')
      for (const [i, root] of entry.settings.roots.entries()) {
        const id = entry.identities[i]
        if (
          typeof id !== 'string' ||
          !/^\d{1,20}:\d{1,20}$/.test(id) ||
          (pinnedRoots.has(root) && pinnedRoots.get(root) !== id)
        )
          throw new Error('Inconsistent NAS directory identities')
        pinnedRoots.set(root, id)
      }
    }
    const revision = createHash('sha256')
      .update(JSON.stringify([packageText, rootsText, pendingText]))
      .digest('hex')
    this.active ??= applied
    const grantChange =
      pending !== null &&
      JSON.stringify(pending.identities) !== JSON.stringify(grants.identities)
    return { applied, settings, revision, grantChange, pinnedRoots }
  }

  async view(): Promise<NasSettingsView> {
    const state = await this.snapshot()
    const active = this.active ?? state.applied
    return {
      platform: this.platform,
      revision: state.revision,
      settings: state.settings,
      active,
      restartRequired:
        state.grantChange ||
        JSON.stringify(state.settings) !== JSON.stringify(active),
    }
  }

  async save(
    raw: unknown,
    validate: (
      settings: NasPackageSettings,
      signal: AbortSignal
    ) => Promise<GrantValidation>
  ): Promise<NasSettingsResult> {
    const parsed = saveNasSettingsSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: { code: 'invalid' } }
    if (Buffer.byteLength(JSON.stringify(parsed.data.settings)) + 1 > MAX_BYTES)
      return { ok: false, error: { code: 'invalid' } }
    let result: NasSettingsResult = {
      ok: false,
      error: { code: 'unavailable' },
    }
    const operation = async () => {
      try {
        const previous = await this.snapshot()
        if (previous.revision !== parsed.data.revision) {
          result = { ok: false, error: { code: 'conflict' } }
          return
        }
        const controller = new AbortController()
        let timedOut = false,
          timer: ReturnType<typeof setTimeout> | undefined
        let valid: GrantValidation
        try {
          valid = await Promise.race([
            validate(parsed.data.settings, controller.signal),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => {
                timedOut = true
                controller.abort()
                resolve(false)
              }, this.validationTimeoutMs)
            }),
          ])
        } finally {
          clearTimeout(timer)
          controller.abort()
        }
        if (valid === false || valid === 'folderUnavailable') {
          result = {
            ok: false,
            error: {
              code: timedOut
                ? 'unavailable'
                : valid === 'folderUnavailable'
                  ? valid
                  : 'permissionDenied',
            },
          }
          return
        }
        if ((await this.snapshot()).revision !== parsed.data.revision) {
          result = { ok: false, error: { code: 'conflict' } }
          return
        }
        if (
          typeof valid === 'object' &&
          parsed.data.settings.roots.some((root, index) => {
            const pinned = previous.pinnedRoots.get(root)
            return (
              pinned !== undefined &&
              pinned !== valid.directoryIdentities[index]
            )
          })
        ) {
          result = { ok: false, error: { code: 'folderUnavailable' } }
          return
        }
        const parent = await lstat(this.directory)
        if (
          !parent.isDirectory() ||
          parent.uid !== process.getuid?.() ||
          (parent.mode & 0o022) !== 0
        )
          throw new Error('Untrusted NAS configuration directory')
        await writeFileAtomic(
          path.join(this.directory, 'pending-settings.json'),
          `${JSON.stringify({
            ...parsed.data.settings,
            ...(typeof valid === 'object' ? valid : {}),
          })}\n`,
          { mode: 0o600 }
        )
        const directory = await open(
          this.directory,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
        )
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
        result = { ok: true, value: await this.view() }
      } catch {
        result = { ok: false, error: { code: 'unavailable' } }
      }
    }
    const queued = this.transition.then(operation, operation)
    this.transition = queued.then(
      () => undefined,
      () => undefined
    )
    await queued
    return result
  }
}
