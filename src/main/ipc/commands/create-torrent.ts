import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  copyFile,
  link,
  lstat,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { createTorrent } from '@core/torrent/create-torrent'
import { AppError, ErrorCode } from '@shared/errors'
import { Commands } from '@shared/protocol/commands'
import { Events } from '@shared/protocol/events'
import type {
  TaskCreateCommandResult,
  TaskCreateRequest,
} from '@shared/schemas/add-task'
import {
  createTorrentRequestSchema,
  pickTorrentSourceSchema,
  saveTorrentFileRequestSchema,
} from '@shared/schemas/create-torrent'
import { BrowserWindow, dialog, type WebContents } from 'electron'

type Created = Awaited<ReturnType<typeof createTorrent>>
interface Selection {
  path: string
  dev: number
  ino: number
  result?: { id: string; torrent: Created }
}
const fail = () =>
  new AppError(
    ErrorCode.TorrentCreateFailed,
    'Torrent creator request is no longer available'
  )

// Claim an initially absent filename without replacing a competing writer.
// FAT/exFAT and some network volumes do not support hard links.
async function publishNewTorrent(file: string, target: string) {
  try {
    await link(file, target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      !['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(
        code ?? ''
      )
    )
      throw error
    await copyFile(file, target, constants.COPYFILE_EXCL)
  }
}

export function torrentCreatorHandlers(
  isCreator: (sender: WebContents) => boolean,
  seed: (request: TaskCreateRequest) => Promise<TaskCreateCommandResult>,
  enterModal?: () => (() => void) | undefined
) {
  async function nativeDialog<T>(show: () => Promise<T>): Promise<T> {
    const leave = enterModal?.()
    try {
      return await show()
    } finally {
      leave?.()
    }
  }
  const sessions = new WeakMap<WebContents, Selection>()
  let busy = false
  const exclusive = async <T>(
    sender: WebContents,
    action: () => Promise<T>
  ): Promise<T> => {
    if (busy || sender.isDestroyed() || !isCreator(sender)) throw fail()
    busy = true
    try {
      return await action()
    } finally {
      busy = false
    }
  }
  return {
    [Commands.PickTorrentSource]: (sender: WebContents, raw: unknown) =>
      exclusive(sender, async () => {
        const kind = pickTorrentSourceSchema.parse(raw)
        const win = BrowserWindow.fromWebContents(sender)
        if (!win) throw fail()
        const picked = await nativeDialog(() =>
          dialog.showOpenDialog(win, {
            properties: [kind === 'file' ? 'openFile' : 'openDirectory'],
          })
        )
        if (picked.canceled || !picked.filePaths[0] || sender.isDestroyed())
          return null
        const source = await realpath(picked.filePaths[0])
        const stat = await lstat(source)
        if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) throw fail()
        sessions.set(sender, { path: source, dev: stat.dev, ino: stat.ino })
        return { path: source }
      }),
    [Commands.CreateTorrent]: (sender: WebContents, raw: unknown) =>
      exclusive(sender, async () => {
        const options = createTorrentRequestSchema.parse(raw)
        const selection = sessions.get(sender)
        if (!selection) throw fail()
        delete selection.result
        const abort = new AbortController()
        const cancel = () => abort.abort()
        sender.once('destroyed', cancel)
        let last = 0
        try {
          const torrent = await createTorrent(
            { ...options, sourcePath: selection.path },
            {
              signal: abort.signal,
              picked: selection,
              onProgress(processed, total) {
                if (
                  sender.isDestroyed() ||
                  (processed !== total && Date.now() - last < 250)
                )
                  return
                last = Date.now()
                sender.send(
                  Events.CreateTorrentProgress,
                  total ? Math.min(1, processed / total) : 1
                )
              },
            }
          )
          abort.signal.throwIfAborted()
          const id = randomUUID()
          selection.result = { id, torrent }
          const { bytes: _bytes, directory: _directory, ...summary } = torrent
          return { ...summary, id }
        } finally {
          sender.removeListener('destroyed', cancel)
        }
      }),
    [Commands.SaveTorrentFile]: (sender: WebContents, raw: unknown) =>
      exclusive(sender, async () => {
        const request = saveTorrentFileRequestSchema.parse(raw)
        const selection = sessions.get(sender)
        if (!selection?.result || selection.result.id !== request.id)
          throw fail()
        const { torrent } = selection.result
        const win = BrowserWindow.fromWebContents(sender)
        if (!win) throw fail()
        const save = await nativeDialog(() =>
          dialog.showSaveDialog(win, {
            defaultPath: path.join(
              path.dirname(selection.path),
              `${torrent.name}.torrent`
            ),
            filters: [{ name: 'BitTorrent', extensions: ['torrent'] }],
          })
        )
        if (save.canceled || !save.filePath || sender.isDestroyed()) return null
        // Resolve the parent even for a new destination. Never follow an output
        // symlink or replace an existing member of the selected directory.
        const target = path.join(
          await realpath(path.dirname(save.filePath)),
          path.basename(save.filePath)
        )
        const stat = await lstat(target).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'ENOENT') throw e
          return null
        })
        const relative = path.relative(selection.path, target)
        if (stat) {
          const sourceStat = await lstat(selection.path)
          if (stat.dev === sourceStat.dev && stat.ino === sourceStat.ino)
            throw fail()
          if (torrent.directory) {
            // Case-insensitive aliases and bind mounts need an identity check;
            // a lexical containment check alone can miss the same directory.
            for (let parent = path.dirname(target); ; ) {
              const parentStat = await lstat(parent)
              if (
                parentStat.dev === sourceStat.dev &&
                parentStat.ino === sourceStat.ino
              )
                throw fail()
              const next = path.dirname(parent)
              if (next === parent) break
              parent = next
            }
          }
        }
        if (
          !relative ||
          stat?.isSymbolicLink() ||
          (stat &&
            torrent.directory &&
            !relative.startsWith(`..${path.sep}`) &&
            relative !== '..' &&
            !path.isAbsolute(relative))
        )
          throw fail()
        // Rename the directory entry itself; following a destination symlink
        // between the check above and the write could overwrite source data.
        const staging = await mkdtemp(
          path.join(path.dirname(target), '.motrix-torrent-')
        )
        try {
          const file = path.join(staging, 'metainfo')
          await writeFile(file, torrent.bytes, { flag: 'wx', mode: 0o600 })
          if (stat) await rename(file, target)
          else await publishNewTorrent(file, target)
        } finally {
          await rm(staging, { recursive: true, force: true }).catch(
            () => undefined
          )
        }
        delete selection.result
        if (!request.seed) return { path: target, seeding: 'not-requested' }
        try {
          const task = await seed({
            type: 'bt',
            payload: { kind: 'torrent-base64', base64: '' },
            torrentBytes: Uint8Array.from(torrent.bytes),
            selectedFiles: Array.from(
              { length: torrent.fileCount },
              (_, index) => index
            ),
            saveDir: path.dirname(selection.path),
            duplicatePolicy: 'use-existing',
          })
          if (
            task.outcome !== 'created' &&
            task.outcome !== 'reused' &&
            task.outcome !== 'rechecked'
          )
            throw fail()
          return { path: target, seeding: 'submitted' }
        } catch {
          return { path: target, seeding: 'failed' }
        }
      }),
  }
}
