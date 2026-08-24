import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  LinuxDefaultAssociations,
  LinuxPackageKind,
} from '@shared/types/linux-default-apps'
import { app } from 'electron'
import {
  isUsableHandlerEntry,
  parseDesktopEntry,
  parseExecValue,
} from './appimage-integration'

const execFileAsync = promisify(execFile)

const TORRENT_MIME = 'application/x-bittorrent'
const MAGNET_MIME = 'x-scheme-handler/magnet'
const COMMAND_TIMEOUT_MS = 5_000
const NATIVE_DESKTOP_IDS = ['motrix.desktop', 'motrix-turbo.desktop'] as const

interface LinuxDefaultAppsDeps {
  platform?: NodeJS.Platform
  packaged?: boolean
  env?: NodeJS.ProcessEnv
  home?: string
  currentExecutable?: string
  readDesktopFile?: (filePath: string) => Promise<string | null>
  queryDefault?: (mime: string) => Promise<{ ok: boolean; id: string | null }>
  setDefault?: (desktopId: string, mime: string) => Promise<boolean>
}

function safeDesktopId(value: string | undefined): string | null {
  if (!value || path.basename(value) !== value) return null
  if (!/^[A-Za-z0-9._-]+\.desktop$/.test(value) || value.startsWith('-')) {
    return null
  }
  return value
}

export function detectLinuxPackageKind(
  env: NodeJS.ProcessEnv,
  packaged: boolean
): LinuxPackageKind {
  if (!packaged) return 'unknown'
  if (env.APPIMAGE) return 'appimage'
  if (env.FLATPAK_ID) return 'flatpak'
  if (env.SNAP || env.SNAP_NAME || env.SNAP_INSTANCE_NAME) return 'snap'
  return 'native'
}

function desktopCandidates(
  packageKind: LinuxPackageKind,
  env: NodeJS.ProcessEnv
): string[] {
  if (packageKind === 'appimage') return ['motrix-appimage.desktop']
  if (packageKind === 'flatpak') {
    const id = safeDesktopId(
      env.FLATPAK_ID ? `${env.FLATPAK_ID}.desktop` : undefined
    )
    return id ? [id] : []
  }
  if (packageKind === 'snap') {
    const instance = env.SNAP_INSTANCE_NAME ?? env.SNAP_NAME ?? 'motrix'
    return [
      `${instance}_motrix.desktop`,
      `${instance}_motrix-turbo.desktop`,
    ].flatMap((id) => {
      const safe = safeDesktopId(id)
      return safe ? [safe] : []
    })
  }
  if (packageKind === 'native') return [...NATIVE_DESKTOP_IDS]
  return []
}

function applicationDirs(env: NodeJS.ProcessEnv, home: string): string[] {
  const dataHome =
    env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
      ? env.XDG_DATA_HOME
      : path.join(home, '.local', 'share')
  const dataDirs = (env.XDG_DATA_DIRS ?? '/usr/local/share:/usr/share')
    .split(':')
    .filter((dir) => path.isAbsolute(dir))

  return [
    path.join(dataHome, 'applications'),
    ...dataDirs.map((dir) => path.join(dir, 'applications')),
    path.join(home, '.local/share/flatpak/exports/share/applications'),
    '/var/lib/flatpak/exports/share/applications',
    '/var/lib/snapd/desktop/applications',
    '/app/share/applications',
    ...(env.SNAP && path.isAbsolute(env.SNAP)
      ? [path.join(env.SNAP, 'meta', 'gui')]
      : []),
  ]
}

async function defaultReadDesktopFile(
  filePath: string
): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return null
  }
}

function desktopEntryTargetsCurrentExecutable(
  content: string,
  currentExecutable: string
): boolean {
  const entry = parseDesktopEntry(content)
  if (!isUsableHandlerEntry(entry)) return false
  const program = parseExecValue(entry.get('Exec') ?? '')[0]
  if (!program) return false
  if (path.isAbsolute(program)) {
    return path.normalize(program) === path.normalize(currentExecutable)
  }
  return !program.includes('/') && program === path.basename(currentExecutable)
}

async function defaultQueryDefault(
  mime: string
): Promise<{ ok: boolean; id: string | null }> {
  try {
    const { stdout } = await execFileAsync(
      'xdg-mime',
      ['query', 'default', mime],
      { timeout: COMMAND_TIMEOUT_MS }
    )
    const id = stdout.toString().trim()
    return { ok: true, id: id || null }
  } catch {
    return { ok: false, id: null }
  }
}

async function defaultSetDefault(
  desktopId: string,
  mime: string
): Promise<boolean> {
  try {
    await execFileAsync('xdg-mime', ['default', desktopId, mime], {
      timeout: COMMAND_TIMEOUT_MS,
    })
    return (await defaultQueryDefault(mime)).id === desktopId
  } catch {
    return false
  }
}

async function resolveInstalledDesktopIds(
  packageKind: LinuxPackageKind,
  env: NodeJS.ProcessEnv,
  home: string,
  currentExecutable: string,
  readDesktopFile: (filePath: string) => Promise<string | null>
): Promise<string[]> {
  const candidates = desktopCandidates(packageKind, env)
  const dirs = applicationDirs(env, home)
  const installed: string[] = []
  for (const id of candidates) {
    for (const dir of dirs) {
      const content = await readDesktopFile(path.join(dir, id))
      if (content === null) continue
      const valid =
        packageKind === 'native'
          ? desktopEntryTargetsCurrentExecutable(content, currentExecutable)
          : isUsableHandlerEntry(parseDesktopEntry(content))
      if (valid) installed.push(id)
      // Desktop IDs obey XDG directory precedence. A stale/foreign user entry
      // shadows a system entry with the same id, so never continue past the
      // first existing file merely because its Exec failed validation.
      break
    }
  }

  // A confined Snap can see its unprefixed source entry but not the host
  // export. Map each source basename to only its instance-prefixed export id;
  // native deb/rpm ids must never be attributed to the Snap.
  if (packageKind === 'snap' && env.SNAP && path.isAbsolute(env.SNAP)) {
    const sourceToExport = new Map([
      ['motrix.desktop', candidates[0]],
      ['motrix-turbo.desktop', candidates[1]],
    ])
    for (const [sourceId, exportId] of sourceToExport) {
      if (!exportId || installed.includes(exportId)) continue
      const content = await readDesktopFile(
        path.join(env.SNAP, 'meta', 'gui', sourceId)
      )
      if (
        content !== null &&
        isUsableHandlerEntry(parseDesktopEntry(content))
      ) {
        installed.push(exportId)
      }
    }
  }
  return installed
}

function unsupported(): LinuxDefaultAssociations {
  return {
    supported: false,
    packageKind: null,
    registered: false,
    canSetTorrentDefault: false,
    torrent: null,
    magnet: null,
  }
}

export async function getLinuxDefaultAssociations(
  deps: LinuxDefaultAppsDeps = {}
): Promise<LinuxDefaultAssociations> {
  if ((deps.platform ?? process.platform) !== 'linux') return unsupported()

  const packaged = deps.packaged ?? app.isPackaged
  const env = deps.env ?? process.env
  const packageKind = detectLinuxPackageKind(env, packaged)
  if (packageKind === 'unknown') return unsupported()

  const home = deps.home ?? app.getPath('home')
  const currentExecutable = deps.currentExecutable ?? app.getPath('exe')
  const desktopIds = await resolveInstalledDesktopIds(
    packageKind,
    env,
    home,
    currentExecutable,
    deps.readDesktopFile ?? defaultReadDesktopFile
  )
  if (desktopIds.length === 0) {
    return {
      supported: true,
      packageKind,
      registered: false,
      canSetTorrentDefault: false,
      torrent: false,
      magnet: false,
    }
  }

  const queryDefault = deps.queryDefault ?? defaultQueryDefault
  const [torrent, magnet] = await Promise.all([
    queryDefault(TORRENT_MIME),
    queryDefault(MAGNET_MIME),
  ])

  return {
    supported: true,
    packageKind,
    registered: true,
    canSetTorrentDefault: packageKind === 'native',
    torrent: torrent.ok
      ? torrent.id !== null && desktopIds.includes(torrent.id)
      : null,
    magnet: magnet.ok
      ? magnet.id !== null && desktopIds.includes(magnet.id)
      : null,
  }
}

export async function setLinuxDefaultTorrentHandler(
  deps: LinuxDefaultAppsDeps = {}
): Promise<LinuxDefaultAssociations> {
  const status = await getLinuxDefaultAssociations(deps)
  if (
    !status.supported ||
    status.packageKind !== 'native' ||
    !status.registered
  ) {
    throw new Error('Linux package does not support direct default selection')
  }

  const env = deps.env ?? process.env
  const home = deps.home ?? app.getPath('home')
  const currentExecutable = deps.currentExecutable ?? app.getPath('exe')
  const [desktopId] = await resolveInstalledDesktopIds(
    status.packageKind,
    env,
    home,
    currentExecutable,
    deps.readDesktopFile ?? defaultReadDesktopFile
  )
  if (!desktopId) throw new Error('Motrix desktop entry not found')

  const setDefault = deps.setDefault ?? defaultSetDefault
  if (!(await setDefault(desktopId, TORRENT_MIME))) {
    throw new Error('Desktop environment rejected the default handler')
  }
  return getLinuxDefaultAssociations(deps)
}
