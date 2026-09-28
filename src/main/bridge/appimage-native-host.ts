import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  chmod,
  copyFile,
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import type {
  AppImageNativeHostIssue,
  AppImageNativeHostView,
} from '@shared/schemas/appimage-native-host'
import writeFileAtomic from 'write-file-atomic'
import { z } from 'zod'
import {
  computeManifestPaths,
  type SyncArgs,
} from './native-messaging-installer'

export const APPIMAGE_HOST_NAME = 'motrix-appimage-native-host'
const CONFIG_NAME = 'appimage.json'
const MAX_CONFIG_BYTES = 16 * 1024
const absolutePath = z
  .string()
  .refine(
    (p) =>
      isAbsolute(p) &&
      normalize(p) === p &&
      !Array.from(p).some(
        (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
      )
  )
const hash = z.string().regex(/^[a-f0-9]{64}$/u)
const configSchema = z.strictObject({
  schemaVersion: z.literal(1),
  installId: z.uuid(),
  consent: z.enum(['accepted', 'declined']),
  enabled: z.boolean(),
  appImagePath: absolutePath,
  userDataDir: absolutePath,
  bridgeDataDir: absolutePath,
  arch: z.enum(['x64', 'arm64']),
  hostSha256: hash,
  appImageSha256: hash,
  manifests: z
    .array(z.strictObject({ path: absolutePath, sha256: hash }))
    .max(4),
})
type Config = z.infer<typeof configSchema>

export interface AppImageNativeHostOptions {
  home: string
  env: NodeJS.ProcessEnv
  appImagePath: string
  sourceHostPath: string
  userDataDir: string
  bridgeDataDir: string
  arch: string
  /** Tests use isolated system directories. Production checks the real roots. */
  systemManifestRoots?: string[]
}

class InstallError extends Error {
  constructor(readonly issue: AppImageNativeHostIssue) {
    super(issue)
  }
}
function code(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined
}
function digest(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}
function xdg(value: string | undefined, fallback: string): string {
  return value && isAbsolute(value) ? value : fallback
}

/** Private files are never opened through a symlink. Ancestors may be root owned. */
async function checkParents(path: string): Promise<void> {
  let current = path
  for (;;) {
    try {
      const stat = await lstat(current)
      const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        (stat.uid !== process.getuid?.() && stat.uid !== 0) ||
        ((stat.mode & 0o022) !== 0 && !stickyRoot)
      )
        throw new InstallError('permissions')
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error
    }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

async function readOwned(
  path: string,
  privateFile = false
): Promise<Buffer | null> {
  await checkParents(dirname(path))
  let file: FileHandle
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (code(error) === 'ENOENT') return null
    throw error
  }
  try {
    const stat = await file.stat()
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & (privateFile ? 0o077 : 0o022)) !== 0
    )
      throw new InstallError('permissions')
    if (stat.size > MAX_CONFIG_BYTES) throw new InstallError('invalid')
    return await file.readFile()
  } finally {
    await file.close()
  }
}

async function binaryHash(
  path: string,
  arch: string,
  owned: boolean
): Promise<string> {
  await checkParents(dirname(path))
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (
      !before.isFile() ||
      (before.mode & 0o111) === 0 ||
      (before.mode & 0o022) !== 0 ||
      (owned && before.uid !== process.getuid?.())
    )
      throw new InstallError('permissions')
    const header = Buffer.alloc(20)
    await file.read(header, 0, header.length, 0)
    const machine = arch === 'x64' ? 62 : arch === 'arm64' ? 183 : -1
    if (
      header.subarray(0, 4).toString('hex') !== '7f454c46' ||
      header[4] !== 2 ||
      header[5] !== 1 ||
      header.readUInt16LE(18) !== machine
    )
      throw new InstallError('invalid')
    const sha = createHash('sha256')
    const started = Date.now()
    let size = 0
    for await (const chunk of file.createReadStream({
      start: 0,
      autoClose: false,
    })) {
      size += chunk.length
      if (size > 2 ** 31 || Date.now() - started > 5000)
        throw new InstallError('io')
      sha.update(chunk)
    }
    const after = await file.stat()
    const named = await lstat(path)
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.ino !== named.ino ||
      after.dev !== named.dev
    )
      throw new InstallError('sourceChanged')
    return sha.digest('hex')
  } finally {
    await file.close()
  }
}

export class AppImageNativeHost {
  readonly directory: string
  readonly hostPath: string
  private readonly configPath: string
  private transition: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: AppImageNativeHostOptions) {
    this.directory = join(
      xdg(options.env.XDG_DATA_HOME, join(options.home, '.local/share')),
      'motrix/native-messaging/appimage'
    )
    this.hostPath = join(this.directory, APPIMAGE_HOST_NAME)
    this.configPath = join(this.directory, CONFIG_NAME)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.transition.then(operation, operation)
    this.transition = next.catch(() => {})
    return next
  }

  private async config(path = this.configPath): Promise<Config | null> {
    const bytes = await readOwned(path, true)
    if (!bytes) return null
    const parsed = configSchema.safeParse(JSON.parse(bytes.toString('utf8')))
    if (!parsed.success) throw new InstallError('invalid')
    if (parsed.data.userDataDir !== this.options.userDataDir)
      throw new InstallError('conflict')
    return parsed.data
  }

  private manifests(ids: SyncArgs): Map<string, string> {
    const paths = computeManifestPaths(
      'linux',
      this.options.home,
      undefined,
      this.options.env
    )
    const entries = new Map<string, string>()
    for (const [browser, path] of Object.entries(paths)) {
      entries.set(
        path,
        JSON.stringify(
          {
            name: 'app.motrix.bridge',
            description: 'Motrix browser download bridge',
            path: this.hostPath,
            type: 'stdio',
            ...(browser === 'firefox'
              ? { allowed_extensions: ids.firefox }
              : {
                  allowed_origins: ids.chromium.map(
                    (id) => `chrome-extension://${id}/`
                  ),
                }),
          },
          null,
          2
        )
      )
    }
    return entries
  }

  private async assertManifest(
    path: string,
    configs: (Config | null)[],
    legacy?: string
  ): Promise<boolean> {
    const bytes = await readOwned(path)
    if (!bytes) return false
    const matches = configs.some((c) =>
      c?.manifests.some((r) => r.path === path && r.sha256 === digest(bytes))
    )
    if (!matches && bytes.toString('utf8') !== legacy)
      throw new InstallError('conflict')
    return true
  }

  private async writeNew(path: string, data: string): Promise<void> {
    await checkParents(dirname(path))
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      await writeFileAtomic(temp, data, { mode: 0o600 })
      await link(temp, path)
    } finally {
      await rm(temp, { force: true })
    }
  }

  private async install(ids: SyncArgs, enabled: boolean): Promise<void> {
    const old = await this.config()
    const backup = await this.config(`${this.configPath}.bak`)
    const entries = this.manifests(ids)
    for (const root of this.options.systemManifestRoots ?? [
      '/etc/opt/chrome/native-messaging-hosts',
      '/etc/chromium/native-messaging-hosts',
      '/etc/opt/edge/native-messaging-hosts',
      '/usr/lib/mozilla/native-messaging-hosts',
      '/usr/lib64/mozilla/native-messaging-hosts',
    ]) {
      try {
        await lstat(join(root, 'app.motrix.bridge.json'))
        throw new InstallError('conflict')
      } catch (error) {
        if (code(error) !== 'ENOENT') throw error
      }
    }
    const existed = new Map<string, boolean>()
    for (const [path, content] of entries) {
      const legacy = JSON.stringify(
        { ...JSON.parse(content), path: this.options.sourceHostPath },
        null,
        2
      )
      existed.set(path, await this.assertManifest(path, [old, backup], legacy))
    }
    const image = await realpath(this.options.appImagePath)
    absolutePath.parse(image)
    const appImageSha256 = await binaryHash(image, this.options.arch, true)
    const hostSha256 = await binaryHash(
      this.options.sourceHostPath,
      this.options.arch,
      false
    )
    try {
      const existingHash = await binaryHash(
        this.hostPath,
        this.options.arch,
        true
      )
      if (
        ![hostSha256, old?.hostSha256, backup?.hostSha256].includes(
          existingHash
        )
      )
        throw new InstallError('conflict')
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error
    }
    await checkParents(this.directory)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const directoryStat = await lstat(this.directory)
    if (
      directoryStat.uid !== process.getuid?.() ||
      (directoryStat.mode & 0o077) !== 0
    )
      throw new InstallError('permissions')
    const next = configSchema.parse({
      schemaVersion: 1,
      installId: old?.installId ?? randomUUID(),
      consent: 'accepted',
      enabled,
      appImagePath: image,
      userDataDir: this.options.userDataDir,
      bridgeDataDir: this.options.bridgeDataDir,
      arch: this.options.arch,
      hostSha256,
      appImageSha256,
      manifests: [...entries].map(([path, content]) => ({
        path,
        sha256: digest(content),
      })),
    })
    // Claim the shared slot before replacing the executable. A competing
    // profile cannot write its own config over the winner.
    if (!old)
      await this.writeNew(
        this.configPath,
        JSON.stringify({ ...next, enabled: false })
      )
    if (old && !backup)
      await this.writeNew(`${this.configPath}.bak`, JSON.stringify(old))
    const temp = join(this.directory, `${randomUUID()}.tmp`)
    try {
      await copyFile(this.options.sourceHostPath, temp, constants.COPYFILE_EXCL)
      await chmod(temp, 0o500)
      if ((await binaryHash(temp, this.options.arch, true)) !== hostSha256)
        throw new InstallError('sourceChanged')
      await rename(temp, this.hostPath)
      await writeFileAtomic(this.configPath, JSON.stringify(next), {
        mode: 0o600,
      })
      if (enabled) {
        for (const [path, content] of entries) {
          if (existed.get(path)) {
            await this.assertManifest(
              path,
              [old, backup],
              JSON.stringify(
                { ...JSON.parse(content), path: this.options.sourceHostPath },
                null,
                2
              )
            )
            await writeFileAtomic(path, content, { mode: 0o600 })
          } else await this.writeNew(path, content)
          if ((await readOwned(path))?.toString('utf8') !== content)
            throw new InstallError('io')
        }
      }
      await rm(`${this.configPath}.bak`, { force: true })
    } finally {
      await rm(temp, { force: true })
    }
  }

  /** Runtime refresh never grants consent or switches to a different image. */
  async sync(ids: SyncArgs): Promise<void> {
    return this.enqueue(async () => {
      const config = await this.config()
      if (config?.consent !== 'accepted') return
      if (config.appImagePath !== (await realpath(this.options.appImagePath)))
        return
      await this.install(ids, true)
    })
  }

  async suspend(): Promise<void> {
    return this.enqueue(() => this.disable(false))
  }

  private async disable(remove: boolean): Promise<void> {
    const config = await this.config()
    if (!config) return
    await writeFileAtomic(
      this.configPath,
      JSON.stringify({
        ...config,
        enabled: false,
        consent: remove ? 'declined' : config.consent,
      }),
      { mode: 0o600 }
    )
    const backup = await this.config(`${this.configPath}.bak`)
    let failure: unknown
    for (const path of new Set(
      [config, backup].flatMap((c) => c?.manifests.map((m) => m.path) ?? [])
    )) {
      try {
        if (await this.assertManifest(path, [config, backup])) await rm(path)
      } catch (error) {
        failure ??= error
      }
    }
    if (remove) {
      try {
        const actual = await binaryHash(this.hostPath, config.arch, true)
        if (actual !== config.hostSha256 && actual !== backup?.hostSha256)
          throw new InstallError('conflict')
        await rm(this.hostPath)
      } catch (error) {
        if (code(error) !== 'ENOENT') failure ??= error
      }
    }
    if (failure) throw failure
    await rm(`${this.configPath}.bak`, { force: true })
  }

  async configure(
    action: 'enable' | 'repair' | 'remove',
    ids: SyncArgs,
    enabled: boolean
  ): Promise<AppImageNativeHostView> {
    return this.enqueue(async () => {
      try {
        if (action === 'remove') await this.disable(true)
        else await this.install(ids, enabled)
        return await this.inspect()
      } catch (error) {
        return this.inspect(this.issue(error))
      }
    })
  }

  async inspect(
    issue: AppImageNativeHostIssue | null = null
  ): Promise<AppImageNativeHostView> {
    let config: Config | null = null
    try {
      config = await this.config()
      if (config?.enabled && config.consent === 'accepted') {
        if (
          (await binaryHash(this.hostPath, config.arch, true)) !==
            config.hostSha256 ||
          (await binaryHash(config.appImagePath, config.arch, true)) !==
            config.appImageSha256
        )
          throw new InstallError('sourceChanged')
        for (const entry of config.manifests) {
          if (!(await this.assertManifest(entry.path, [config])))
            throw new InstallError('missing')
        }
      }
    } catch (error) {
      issue ??= this.issue(error)
    }
    let currentTarget = false
    try {
      currentTarget =
        config?.appImagePath === (await realpath(this.options.appImagePath))
    } catch {
      /* A moved image remains repairable from its new location. */
    }
    return {
      supported: true,
      consent: config?.consent ?? 'unset',
      enabled: config?.enabled ?? false,
      target: config?.appImagePath ?? this.options.appImagePath,
      currentTarget,
      healthy: config?.enabled === true && issue === null,
      issue,
    }
  }

  private issue(error: unknown): AppImageNativeHostIssue {
    if (error instanceof InstallError) return error.issue
    if (code(error) === 'ENOENT') return 'missing'
    if (code(error) === 'EEXIST') return 'conflict'
    if (['EACCES', 'EPERM', 'ELOOP'].includes(String(code(error))))
      return 'permissions'
    if (error instanceof SyntaxError || error instanceof z.ZodError)
      return 'invalid'
    return 'io'
  }
}
