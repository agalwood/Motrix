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
async function readDocument(
  file: string,
  optional = false
): Promise<string | null> {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW
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
      info.size > MAX_BYTES
    )
      throw new Error('Untrusted NAS configuration')
    const buffer = Buffer.alloc(MAX_BYTES + 1)
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
    if (bytesRead > MAX_BYTES) throw new Error('NAS configuration too large')
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
      readDocument(path.join(this.directory, 'package-settings.json')),
      readDocument(path.join(this.directory, 'directories.json')),
      readDocument(path.join(this.directory, 'pending-settings.json'), true),
    ])
    const applied = nasPackageSettingsSchema.parse({
      ...JSON.parse(packageText ?? ''),
      ...JSON.parse(rootsText ?? ''),
    })
    const settings =
      pendingText === null
        ? applied
        : nasPackageSettingsSchema.parse(JSON.parse(pendingText))
    const revision = createHash('sha256')
      .update(JSON.stringify([packageText, rootsText, pendingText]))
      .digest('hex')
    this.active ??= applied
    return { applied, settings, revision }
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
        JSON.stringify(state.settings) !== JSON.stringify(active),
    }
  }

  async save(
    raw: unknown,
    validate: (
      settings: NasPackageSettings,
      signal: AbortSignal
    ) => Promise<boolean>
  ): Promise<NasSettingsResult> {
    const parsed = saveNasSettingsSchema.safeParse(raw)
    if (!parsed.success) return { ok: false, error: { code: 'invalid' } }
    const serialized = `${JSON.stringify(parsed.data.settings)}\n`
    if (Buffer.byteLength(serialized) > MAX_BYTES)
      return { ok: false, error: { code: 'invalid' } }
    let result: NasSettingsResult = {
      ok: false,
      error: { code: 'unavailable' },
    }
    const operation = async () => {
      try {
        if ((await this.snapshot()).revision !== parsed.data.revision) {
          result = { ok: false, error: { code: 'conflict' } }
          return
        }
        const controller = new AbortController()
        let timedOut = false,
          timer: ReturnType<typeof setTimeout> | undefined
        let valid: boolean
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
        if (!valid) {
          result = {
            ok: false,
            error: { code: timedOut ? 'unavailable' : 'permissionDenied' },
          }
          return
        }
        if ((await this.snapshot()).revision !== parsed.data.revision) {
          result = { ok: false, error: { code: 'conflict' } }
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
          serialized,
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
