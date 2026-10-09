import { lstat, mkdir, mkdtemp, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Aria2ProcessInspector } from '@core/engine/aria2/aria2-process-inspector'
import type { LegacyBtActivationService } from '@core/legacy-import/bt-activation-service'
import type { LegacyImportService } from '@core/legacy-import/import-service'
import { isInactiveLegacyTask } from '@core/legacy-import/legacy-task-policy'
import {
  authorizeLegacySource,
  readLegacyFile,
} from '@core/legacy-import/source-scanner'
import { TorrentParser } from '@core/torrent/torrent-parser'
import { AppError, ErrorCode } from '@shared/errors'
import { analyzeDownloadSource } from '@shared/lib/download-source'
import { Commands } from '@shared/protocol/commands'
import { Queries } from '@shared/protocol/queries'
import {
  type LegacyImportNavigationState,
  legacyMetadataRequestSchema,
  legacyRunRequestSchema,
  legacyScanRequestSchema,
  legacyTaskMetadataSchema,
  legacyTaskRequestSchema,
} from '@shared/schemas/legacy-import'
import type { AddTaskPrefill } from '@shared/schemas/show-add-task-window'
import type { DownloadTask } from '@shared/types/task'
import { TaskType } from '@shared/types/task'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import writeFileAtomic from 'write-file-atomic'
import { registerTrustedIpcHandler } from '../ipc/trusted-ipc'
import { i18n } from '../lib/i18n'

export function defaultLegacyRoots(): string[] {
  // Hermetic end-to-end launches never inspect the developer's real profiles.
  if (!app.isPackaged && process.env.NODE_ENV === 'test') {
    const fixture = process.env.MOTRIX_LEGACY_PROFILE
    return fixture && path.isAbsolute(fixture) ? [fixture] : []
  }
  if (process.platform === 'darwin')
    return [path.join(os.homedir(), 'Library', 'Application Support', 'Motrix')]
  if (process.platform === 'win32')
    return [
      path.join(
        process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
        'Motrix'
      ),
    ]
  return [
    path.join(
      process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
      'Motrix'
    ),
    path.join(os.homedir(), '.config', 'motrix'),
  ]
}

export async function legacyPidRunning(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false
  }
  const processInfo = await new Aria2ProcessInspector().inspectPid(pid)
  if (!processInfo) return true
  const identities = [
    processInfo.name,
    processInfo.executablePath ?? '',
  ].filter((value) => value && value !== 'unknown')
  // An inaccessible identity remains a reason to close/recheck v1. A reused
  // PID with a known unrelated executable must not block import.
  return (
    identities.length === 0 ||
    identities.some((value) => /(^|[/\\])aria2c(?:\.exe)?$/i.test(value))
  )
}

interface DesktopImportDeps {
  getService: () => LegacyImportService
  getActivationService?: () => LegacyBtActivationService
  hasConsent: () => boolean
  getTask: (taskId: string) => DownloadTask | undefined
  backupRoot: string
  finishInvitation: () => void
  getNavigationState?: () => LegacyImportNavigationState
  onSourceDetected?: () => void
  waitForTasksReady?: () => Promise<void>
  runAcceptedMutation?: <T>(operation: () => Promise<T>) => Promise<T>
}

export function registerLegacyImportIpc(deps: DesktopImportDeps): () => void {
  const prepared = new Map<string, Promise<AddTaskPrefill | null>>()
  const service = () => {
    if (!deps.hasConsent())
      throw new AppError(
        ErrorCode.InvalidSelection,
        'legacyImport.errors.consentRequired'
      )
    return deps.getService()
  }
  const readyService = async () => {
    service()
    await deps.waitForTasksReady?.()
    return service()
  }
  const handlers: Record<
    string,
    (event: Electron.IpcMainInvokeEvent, input?: unknown) => Promise<unknown>
  > = {
    [Queries.GetLegacyImportNavigation]: async () => {
      service()
      return (
        deps.getNavigationState?.() ?? {
          detected: false,
          invitationPending: false,
        }
      )
    },
    [Queries.GetLegacyBtActivationAvailability]: async (_event, input) => {
      await readyService()
      if (!deps.getActivationService)
        throw new AppError(
          ErrorCode.EngineFeatureUnavailable,
          'legacyImport.errors.checkpointUnavailable'
        )
      return deps
        .getActivationService()
        .availability(legacyTaskRequestSchema.parse(input).taskId)
    },
    [Commands.ActivateLegacyBt]: async (event, input) => {
      await readyService()
      const { taskId } = legacyTaskRequestSchema.parse(input)
      const owner = BrowserWindow.fromWebContents(event.sender)
      if (!owner || !deps.getActivationService)
        throw new AppError(
          ErrorCode.EngineFeatureUnavailable,
          'legacyImport.errors.checkpointUnavailable'
        )
      return deps.getActivationService().activate(taskId, async (directory) => {
        const result = await dialog.showOpenDialog(owner, {
          title: i18n.t('legacyImport.authorizeOriginalDirectory'),
          defaultPath: directory,
          properties: ['openDirectory'],
        })
        return result.canceled || result.filePaths.length !== 1
          ? null
          : result.filePaths[0]
      })
    },
    [Queries.DiscoverLegacyImport]: async () =>
      service().discover(defaultLegacyRoots()),
    [Commands.RevealLegacyImportSource]: async (_event, input) => {
      const current = service()
      const { sourceHandle } = legacyScanRequestSchema.parse(input)
      shell.showItemInFolder(current.getSourcePath(sourceHandle))
    },
    [Queries.ScanLegacyImport]: async (_event, input) => {
      const preview = await service().scan(
        legacyScanRequestSchema.parse(input).sourceHandle
      )
      deps.onSourceDetected?.()
      return preview
    },
    [Queries.GetLegacyImportRun]: async (_event, input) =>
      service().getRun(legacyRunRequestSchema.parse(input).runId),
    [Commands.CommitLegacyImport]: async (_event, input) => {
      return (await readyService()).commit(input)
    },
    [Commands.CancelLegacyImport]: async (_event, input) =>
      service().cancel(legacyRunRequestSchema.parse(input).runId),
    [Commands.RetryLegacyImport]: async (_event, input) => {
      return (await readyService()).retry(
        legacyRunRequestSchema.parse(input).runId
      )
    },
    [Commands.DismissLegacyImportInvitation]: async () => {
      service().dismissInvitation()
      deps.finishInvitation()
      return { ok: true }
    },
    [Commands.FinishLegacyImportInvitation]: async () => {
      service().dismissInvitation()
      deps.finishInvitation()
      return { ok: true }
    },
    [Commands.PickLegacyImportSource]: async (event) => {
      service()
      const owner = BrowserWindow.fromWebContents(event.sender)
      if (!owner)
        throw new AppError(
          ErrorCode.InvalidSelection,
          'legacyImport.errors.sourceNotAuthorized'
        )
      const result = await dialog.showOpenDialog(owner, {
        title: i18n.t('legacyImport.pickSource'),
        properties: ['openDirectory'],
      })
      if (result.canceled || !result.filePaths[0]) return null
      const current = service()
      const dataPath = result.filePaths[0]
      try {
        return await current.addSource(dataPath)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        const errorCode =
          message.match(
            /legacyImport\.(?:errors\.)?(invalidSource|unsafeSource|changedSource|tooManySources)\b/
          )?.[1] ?? 'failed'
        // A rejected native selection is display-only and carries no source grant.
        return { dataPath, errorCode }
      }
    },
    [Commands.PickLegacyTorrentMetadata]: async (event, input) => {
      const request = legacyMetadataRequestSchema.parse(input)
      const owner = BrowserWindow.fromWebContents(event.sender)
      if (!owner)
        throw new AppError(
          ErrorCode.InvalidSelection,
          'legacyImport.errors.sourceNotAuthorized'
        )
      return service().authorizeMetadata(request, async () => {
        const result = await dialog.showOpenDialog(owner, {
          title: i18n.t('legacyImport.chooseTorrent'),
          properties: ['openFile'],
          filters: [
            {
              name: i18n.t('legacyImport.torrentFile'),
              extensions: ['torrent'],
            },
          ],
        })
        if (result.canceled || result.filePaths.length !== 1) return null
        return result.filePaths[0]
      })
    },
    [Commands.ExportLegacyImportReport]: async (event, input) => {
      const report = service().getRun(legacyRunRequestSchema.parse(input).runId)
      const owner = BrowserWindow.fromWebContents(event.sender)
      if (!owner) return false
      const result = await dialog.showSaveDialog(owner, {
        title: i18n.t('legacyImport.exportReport'),
        defaultPath: `motrix-import-${report.runId}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (result.canceled || !result.filePath) return false
      await writeFileAtomic(result.filePath, JSON.stringify(report, null, 2), {
        mode: 0o600,
        fsync: true,
      })
      return true
    },
    [Commands.PrepareLegacyFreshDownload]: async (event, input) => {
      service()
      const { taskId } = legacyTaskRequestSchema.parse(input)
      if (prepared.has(taskId)) return prepared.get(taskId)
      const operation = prepareFreshDownload(event, taskId, deps)
      prepared.set(taskId, operation)
      try {
        return await operation
      } finally {
        prepared.delete(taskId)
      }
    },
  }
  const taskMutations = new Set<string>([
    Commands.CommitLegacyImport,
    Commands.RetryLegacyImport,
    Commands.ActivateLegacyBt,
  ])
  for (const [channel, handler] of Object.entries(handlers))
    registerTrustedIpcHandler(channel, (event, input) =>
      taskMutations.has(channel) && deps.runAcceptedMutation
        ? deps.runAcceptedMutation(() => handler(event, input))
        : handler(event, input)
    )
  return () => {
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
  }
}

async function prepareFreshDownload(
  event: Electron.IpcMainInvokeEvent,
  taskId: string,
  deps: DesktopImportDeps
): Promise<AddTaskPrefill | null> {
  const task = deps.getTask(taskId)
  if (!task || !isInactiveLegacyTask(task))
    throw new AppError(
      ErrorCode.InvalidSelection,
      'legacyImport.errors.unknownTask'
    )
  const marker = legacyTaskMetadataSchema.parse(
    task.instances[0]?.payload.legacyImport
  )
  let prefill: AddTaskPrefill
  if (task.type === TaskType.Bt) {
    const metaPath = task.torrentMetaPath
    if (!metaPath)
      throw new AppError(
        ErrorCode.InvalidSelection,
        'legacyImport.errors.metadataRequired'
      )
    const backupRoot = await realpath(deps.backupRoot)
    const relative = path.relative(backupRoot, metaPath)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
      throw new AppError(
        ErrorCode.InvalidSelection,
        'legacyImport.errors.unsafeSource'
      )
    const file = await readLegacyFile(
      await authorizeLegacySource(backupRoot),
      relative
    )
    if (!file)
      throw new AppError(
        ErrorCode.InvalidSelection,
        'legacyImport.errors.metadataRequired'
      )
    const base64 = file.bytes.toString('base64')
    const torrentMeta = await new TorrentParser().parse(base64)
    if (torrentMeta.infoHash !== task.infoHash)
      throw new AppError(
        ErrorCode.InvalidSelection,
        'legacyImport.errors.changedSource'
      )
    prefill = {
      tab: 'torrent',
      source: 'file',
      base64,
      torrentMeta,
      selectedFiles: marker.selectionKnown ? marker.selectedFiles : [],
    }
  } else if (task.type === TaskType.Magnet) {
    const source =
      task.uris.length === 1 ? analyzeDownloadSource(task.uris[0]) : null
    if (source?.status !== 'accepted' || source.protocol !== 'magnet')
      throw new AppError(
        ErrorCode.InvalidSelection,
        'legacyImport.errors.unsafeSource'
      )
    prefill = { tab: 'links', urls: task.uris.join('\n') }
  } else {
    if (task.uris.length !== 1)
      throw new AppError(
        ErrorCode.EngineFeatureUnavailable,
        'legacyImport.errors.mirrorsUnsupported'
      )
    const source = analyzeDownloadSource(task.uris[0])
    if (
      source.status !== 'accepted' ||
      !['http', 'https'].includes(source.protocol)
    )
      throw new AppError(
        ErrorCode.InvalidSelection,
        'legacyImport.errors.unsafeSource'
      )
    prefill = { tab: 'links', urls: task.uris[0], filename: task.finalName }
  }
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!owner) return null
  const result = await dialog.showOpenDialog(owner, {
    title: i18n.t('legacyImport.freshDestination'),
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || !result.filePaths[0]) return null
  if (deps.getTask(taskId) !== task || !isInactiveLegacyTask(task))
    throw new AppError(
      ErrorCode.InvalidSelection,
      'legacyImport.errors.unknownTask'
    )
  const root = await realpath(result.filePaths[0])
  const stat = await lstat(root)
  if (!stat.isDirectory())
    throw new AppError(
      ErrorCode.InvalidSelection,
      'legacyImport.errors.unsafePath'
    )
  await mkdir(root, { recursive: true })
  const freshDir = await mkdtemp(path.join(root, 'Motrix-new-'))
  return { ...prefill, saveDir: freshDir }
}
