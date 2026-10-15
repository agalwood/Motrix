import { DOWNLOAD_ERROR, type DownloadErrorReason } from '@/shared/integration'

export class DownloadPreparationError extends Error {
  constructor(readonly reason: DownloadErrorReason) {
    super(reason)
    this.name = 'DownloadPreparationError'
  }
}

export class DownloadOutcomeUnknownError extends Error {
  constructor() {
    super(DOWNLOAD_ERROR.resultUnknown)
    this.name = 'DownloadOutcomeUnknownError'
  }
}

/** A caller's deadline never cancels a connection shared with other callers. */
export async function beforeDeadline<T>(
  operation: Promise<T>,
  deadlineAt: number
): Promise<T> {
  const remaining = deadlineAt - Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new DownloadPreparationError(DOWNLOAD_ERROR.preparationTimeout)
            ),
          Math.max(0, remaining)
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
