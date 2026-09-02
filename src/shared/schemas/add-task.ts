import { z } from 'zod'

const torrentFileSchema = z.object({
  index: z.number().int().nonnegative(),
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  extension: z.string(),
})

const torrentMetaSchema = z.object({
  name: z.string(),
  infoHash: z.string().length(40),
  totalSize: z.number().int().nonnegative(),
  files: z.array(torrentFileSchema),
})

export { torrentMetaSchema }

const linksTabSchema = z.object({
  tab: z.literal('links'),
  urls: z.string().min(1, { message: 'task.add.errors.urlsRequired' }),
  saveDir: z.string().min(1, { message: 'task.add.errors.saveDirRequired' }),
  filename: z.string().optional(),
  split: z.number().int().min(1).max(128).optional(),
  userAgent: z.string().optional(),
  referer: z.string().optional(),
  cookie: z.string().optional(),
  authorization: z.string().optional(),
  allProxy: z.string().optional(),
})

const torrentTabSchema = z
  .object({
    tab: z.literal('torrent'),
    source: z.enum(['file', 'magnet']),
    base64: z.string().optional(),
    magnetUri: z.string().optional(),
    torrentMeta: torrentMetaSchema,
    selectedFiles: z
      .array(z.number().int().nonnegative())
      .min(1, { message: 'task.add.errors.noFilesSelected' }),
    saveDir: z.string().min(1, { message: 'task.add.errors.saveDirRequired' }),
    dlLimit: z.number().int().nonnegative().optional(),
    ulLimit: z.number().int().nonnegative().optional(),
    seedRatio: z.number().nonnegative().optional(),
    // Plan B Task 3: motrixId of an existing magnet_metadata_resolution
    // task whose instance should be swapped for a bt_download instance
    // in place (preserves the row's identity, created_at, and Downloads
    // list position). Present only on submits originating from a
    // MagnetFileSelection event payload.
    existingTaskId: z.string().min(1).optional(),
  })
  .refine(
    (v) =>
      (v.source === 'file' && !!v.base64) ||
      (v.source === 'magnet' && !!v.magnetUri),
    { message: 'task.add.errors.missingSource', path: ['source'] }
  )

export const addTaskFormSchema = z.discriminatedUnion('tab', [
  linksTabSchema,
  torrentTabSchema,
])
export type AddTaskFormValues = z.infer<typeof addTaskFormSchema>

// ── Engine-agnostic request ─────────────────────────────────

const httpHeaderSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
})

const httpTaskRequestSchema = z.object({
  type: z.literal('http'),
  uris: z.array(z.url()).min(1),
  saveDir: z.string().min(1),
  filename: z.string().optional(),
  connections: z.number().int().min(1).max(128).optional(),
  headers: z.array(httpHeaderSchema).default([]),
  proxy: z.string().optional(),
})

const btTaskRequestSchema = z
  .object({
    type: z.literal('bt'),
    payload: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('torrent-base64'), base64: z.string() }),
      z.object({
        kind: z.literal('magnet'),
        uri: z.string().startsWith('magnet:?'),
      }),
    ]),
    selectedFiles: z.array(z.number().int().nonnegative()).default([]),
    saveDir: z.string().min(1),
    dlLimit: z.number().int().nonnegative().optional(),
    ulLimit: z.number().int().nonnegative().optional(),
    seedRatio: z.number().nonnegative().optional(),
    // Optional display name for dedup/finalName picking. Caller may supply
    // the torrent root name (from parsed torrentMeta) or magnet `dn=` hint.
    displayName: z.string().min(1).optional(),
    // Raw torrent bytes, persisted to TorrentMetaStore for the finalize
    // re-seed dance. Only meaningful for torrent-base64 payloads.
    torrentBytes: z.instanceof(Uint8Array).optional(),
    // Plan B Task 3: when set, the CreateTask handler swaps the
    // magnet_metadata_resolution instance on this motrixId for a new
    // bt_download instance instead of creating a fresh task. Only
    // meaningful for torrent-base64 payloads originating from a
    // MagnetFileSelection event flow.
    existingTaskId: z.string().min(1).optional(),
    // Duplicate torrent handling is conservative by default. A separate copy
    // is created only after the user explicitly confirms the conflict.
    duplicatePolicy: z.enum(['reuse', 'create-copy']).default('reuse'),
  })
  .superRefine((value, ctx) => {
    if (
      value.payload.kind === 'torrent-base64' &&
      value.selectedFiles.length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'task.add.errors.noFilesSelected',
        path: ['selectedFiles'],
      })
    }
  })

export const taskCreateRequestSchema = z.discriminatedUnion('type', [
  httpTaskRequestSchema,
  btTaskRequestSchema,
])
export type TaskCreateRequest = z.input<typeof taskCreateRequestSchema>

export const torrentDuplicateConflictSchema = z.object({
  reason: z.enum(['active-info-hash', 'selection-mismatch', 'existing-files']),
  infoHash: z.string().length(40),
  targetDir: z.string(),
  existingTaskId: z.string().nullable(),
  existingTaskName: z.string().nullable(),
  existingTaskStatus: z.string().nullable(),
  canCreateCopy: z.boolean(),
})

export type TorrentDuplicateConflict = z.infer<
  typeof torrentDuplicateConflictSchema
>

export type TaskCreateSuccessResult = {
  outcome: 'created' | 'reused' | 'rechecked'
  gid: string
  taskId: string
}

export type TaskCreateCommandResult =
  | TaskCreateSuccessResult
  | {
      outcome: 'conflict'
      conflict: TorrentDuplicateConflict
    }

export interface TorrentBatchCreateResult {
  total: number
  succeeded: number
  failed: number
  firstTaskId: string | null
}

export const torrentBatchCreateOptionsSchema = z.object({
  selectedFiles: z
    .array(z.number().int().nonnegative())
    .min(1, { message: 'task.add.errors.noFilesSelected' }),
  saveDir: z.string().min(1, { message: 'task.add.errors.saveDirRequired' }),
  dlLimit: z.number().int().nonnegative().optional(),
  ulLimit: z.number().int().nonnegative().optional(),
  seedRatio: z.number().nonnegative().optional(),
})

export type TorrentBatchCreateOptions = z.infer<
  typeof torrentBatchCreateOptionsSchema
>

export interface TorrentQueueAdvanceResult {
  advanced: boolean
}

// ── URL params ──────────────────────────────────────────────

export const addTaskUrlParamsSchema = z.object({
  w: z.literal('add-task').optional(),
  mode: z.enum(['links', 'torrent']).default('links'),
  url: z.string().trim().min(1).optional(),
  magnet: z.string().startsWith('magnet:?').optional(),
  saveDir: z.string().min(1).optional(),
  userAgent: z.string().optional(),
  referer: z.string().optional(),
  cookie: z.string().optional(),
})
export type AddTaskUrlParams = z.infer<typeof addTaskUrlParamsSchema>

// ── Event payloads (reused from URL params + runtime validation) ─

export const setAddTaskModeEventPayloadSchema = addTaskUrlParamsSchema

export const magnetFileSelectionPayloadSchema = z.object({
  // Plan B Task 3: motrixId of the persisted magnet_metadata_resolution
  // task. The renderer threads it back through the create command as
  // `existingTaskId` so the handler can swap the instance in place
  // (preserving identity, created_at, Downloads list position) rather
  // than creating a duplicate task.
  taskId: z.string().min(1),
  meta: torrentMetaSchema,
  magnetUri: z.string().startsWith('magnet:?'),
  torrentBase64: z.string().min(1),
  saveDir: z.string(),
})

export const protocolTorrentFilePayloadSchema = z.object({
  payload: z.object({ name: z.string(), dataBase64: z.string() }),
  meta: torrentMetaSchema,
  queuePosition: z.number().int().positive().default(1),
  queueTotal: z.number().int().positive().default(1),
})

export const torrentQueueSizeChangedPayloadSchema = z.object({
  queueTotal: z.number().int().positive(),
})

// ── Pure helpers ────────────────────────────────────────────

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

function trimmed(s?: string): string | undefined {
  if (!s) return undefined
  const t = s.trim()
  return t.length === 0 ? undefined : t
}

function compactHeader(name: string, value?: string) {
  const v = trimmed(value)
  return v ? [{ name, value: v }] : []
}

function splitUrlLines(raw: string): string[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/**
 * One request per pasted link line. Each line is an independent download —
 * a magnet line becomes its own bt request, everything else an http request
 * with the shared advanced options. The filename override only applies when
 * exactly one line is present (the same name on several tasks would collide).
 * Mirror semantics (several uris feeding one task) remain available to API
 * callers via the singular converter below.
 */
export function formValuesToTaskCreateRequests(
  v: AddTaskFormValues
): TaskCreateRequest[] {
  if (v.tab !== 'links') return [formValuesToTaskCreateRequest(v)]
  const lines = splitUrlLines(v.urls)
  const filename = lines.length === 1 ? v.filename : undefined
  return lines.map((line) =>
    formValuesToTaskCreateRequest({ ...v, urls: line, filename })
  )
}

export function formValuesToTaskCreateRequest(
  v: AddTaskFormValues
): TaskCreateRequest {
  if (v.tab === 'links') {
    const uris = splitUrlLines(v.urls)
    if (uris.length === 1 && uris[0]?.startsWith('magnet:?')) {
      return {
        type: 'bt',
        payload: { kind: 'magnet', uri: uris[0] },
        selectedFiles: [],
        saveDir: v.saveDir,
        dlLimit: undefined,
        ulLimit: undefined,
        seedRatio: undefined,
      }
    }
    const headers = [
      ...compactHeader('User-Agent', v.userAgent),
      ...compactHeader('Referer', v.referer),
      ...compactHeader('Cookie', v.cookie),
      ...compactHeader('Authorization', v.authorization),
    ]
    return {
      type: 'http',
      uris,
      saveDir: v.saveDir,
      filename: trimmed(v.filename),
      ...(v.split === undefined ? {} : { connections: v.split }),
      headers,
      proxy: trimmed(v.allProxy),
    }
  }

  // v.tab === 'torrent'
  const shouldSubmitTorrentBytes = v.source === 'file' || Boolean(v.base64)
  const payload = shouldSubmitTorrentBytes
    ? ({ kind: 'torrent-base64', base64: v.base64 as string } as const)
    : ({ kind: 'magnet', uri: v.magnetUri as string } as const)

  return {
    type: 'bt',
    payload,
    selectedFiles: v.selectedFiles,
    saveDir: v.saveDir,
    dlLimit: v.dlLimit,
    ulLimit: v.ulLimit,
    seedRatio: v.seedRatio,
    displayName:
      v.source === 'magnet' && shouldSubmitTorrentBytes
        ? v.torrentMeta.name
        : undefined,
    // Plan B Task 3: propagate existingTaskId so the create command
    // handler can swap the magnet_metadata_resolution instance in
    // place instead of creating a new task.
    existingTaskId: v.existingTaskId,
  }
}

export function urlParamsToFormDefaults(
  p: AddTaskUrlParams
): DeepPartial<AddTaskFormValues> {
  if (p.magnet) {
    return {
      tab: 'links',
      urls: p.magnet,
      saveDir: p.saveDir,
    }
  }
  return {
    tab: p.mode ?? 'links',
    urls: p.url ?? '',
    saveDir: p.saveDir,
  }
}

export function encodeUrlParams(p: AddTaskUrlParams): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(p)) {
    if (v !== undefined && v !== null && v !== '') out[k] = String(v)
  }
  return out
}
