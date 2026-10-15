import {
  type DownloadSubmitParams,
  DownloadSubmitParamsSchema,
  type DownloadSubmitResult,
} from '@motrix/mdxp'
import type { DirectorySelection } from '@/shared/downloadDirectories'
import { isDownloadErrorReason } from '@/shared/integration'
import {
  type CreateManualTaskRequest,
  type ParsedManualTaskInput,
  parseManualTaskInput,
} from '@/shared/manualTask'
import {
  applyTaskOptions,
  defaultTaskOptions,
  type TaskOptions,
  taskOptionsSchema,
} from '@/shared/taskOptions'

export interface ManualTaskMessageSender {
  id?: string | undefined
  url?: string | undefined
  tab?: unknown
}

export interface ManualTaskHandlerDeps {
  extensionId: string
  extensionBaseUrl: string
  now?: () => number
  submitDownload: (
    params: DownloadSubmitParams,
    options: {
      pairIfNeeded: boolean
      directory?: DirectorySelection | undefined
    }
  ) => Promise<DownloadSubmitResult>
}

export const MANUAL_TASK_ERROR = {
  forbidden: 'manual-task.forbidden',
  invalidRequest: 'manual-task.invalid-request',
  submitFailed: 'manual-task.submit-failed',
} as const

const MIN_IDEMPOTENCY_KEY_LENGTH = 8
const MAX_IDEMPOTENCY_KEY_LENGTH = 128

export function isExtensionPageSender(
  sender: ManualTaskMessageSender,
  extensionId: string,
  extensionBaseUrl: string
): boolean {
  return (
    sender.id === extensionId &&
    sender.tab == null &&
    typeof sender.url === 'string' &&
    sender.url.startsWith(extensionBaseUrl)
  )
}

export function buildManualTaskSubmitParams(
  parsed: ParsedManualTaskInput,
  idempotencyKey: string,
  detectedAt: number,
  options?: TaskOptions
): DownloadSubmitParams {
  const source = {
    pageUrl: parsed.kind === 'direct' ? parsed.url : parsed.uri,
    pageTitle: parsed.suggestedFilename,
    detectedAt,
  }
  const meta = {
    suggestedFilename: parsed.suggestedFilename,
    qualityLabel: 'file',
  }
  const selection: DownloadSubmitParams['selection'] =
    parsed.kind === 'direct'
      ? {
          kind: 'direct',
          primary: {
            url: parsed.url,
            headers: {},
            cookies: [],
            refererPolicy: 'strict-origin-when-cross-origin',
          },
        }
      : { kind: 'magnet', uri: parsed.uri }

  const result = DownloadSubmitParamsSchema.safeParse({
    source,
    selection,
    meta,
    idempotencyKey,
  })
  if (!result.success) throw new Error(MANUAL_TASK_ERROR.invalidRequest)
  return options ? applyTaskOptions(result.data, options) : result.data
}

export function createManualTaskHandler(deps: ManualTaskHandlerDeps) {
  return async (
    request: CreateManualTaskRequest,
    sender: ManualTaskMessageSender
  ): Promise<DownloadSubmitResult> => {
    if (
      !isExtensionPageSender(sender, deps.extensionId, deps.extensionBaseUrl)
    ) {
      throw new Error(MANUAL_TASK_ERROR.forbidden)
    }

    if (!isValidRequest(request)) {
      throw new Error(MANUAL_TASK_ERROR.invalidRequest)
    }
    const parsed = parseManualTaskInput(request.input)
    if (!parsed.ok) throw new Error(MANUAL_TASK_ERROR.invalidRequest)

    const options = taskOptionsSchema.safeParse(
      request.options ?? defaultTaskOptions(navigator.userAgent)
    )
    if (!options.success) throw new Error(MANUAL_TASK_ERROR.invalidRequest)
    const params = buildManualTaskSubmitParams(
      parsed.value,
      request.idempotencyKey,
      (deps.now ?? Date.now)(),
      options.data
    )

    try {
      return await deps.submitDownload(params, {
        pairIfNeeded: request.pairIfNeeded === true,
        ...(options.data.directory
          ? { directory: options.data.directory }
          : {}),
      })
    } catch (error) {
      if (isDownloadErrorReason((error as Error)?.message)) throw error
      // The transport/desktop error may contain a URL, credentials, or a
      // native path. Only return a stable, localizable reason to the caller.
      throw new Error(MANUAL_TASK_ERROR.submitFailed)
    }
  }
}

function isValidRequest(value: unknown): value is CreateManualTaskRequest {
  if (typeof value !== 'object' || value === null) return false
  const request = value as Partial<CreateManualTaskRequest>
  return (
    typeof request.input === 'string' &&
    typeof request.idempotencyKey === 'string' &&
    request.idempotencyKey.length >= MIN_IDEMPOTENCY_KEY_LENGTH &&
    request.idempotencyKey.length <= MAX_IDEMPOTENCY_KEY_LENGTH
  )
}
