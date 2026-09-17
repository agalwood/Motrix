import { createHash } from 'node:crypto'
import { AppError, ErrorCode } from '@shared/errors'
import type { TaskCreateSuccessResult } from '@shared/schemas/add-task'
import type { DownloadTask } from '@shared/types/task'

interface TaskOwners {
  getAll(): DownloadTask[]
}
export interface CreateRequestReceipt {
  createRequestId: string
  createRequestFingerprint: string
}
const pending = new WeakMap<
  TaskOwners,
  Map<string, { fingerprint: string; result: Promise<TaskCreateSuccessResult> }>
>()

export function createRequestFingerprint(request: unknown): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex')
}

/** Deterministic UUIDv8 so a remote client's retry survives a host restart. */
export function scopedCreateRequestId(client: string, key: string): string {
  const bytes = createHash('sha256')
    .update(JSON.stringify(['mdxp.download/add', client, key]))
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Coalesce concurrent sends; the task graph retains receipts across a host restart. */
export function runCreateRequest(
  owners: TaskOwners,
  id: string | undefined,
  fingerprint: string,
  create: () => Promise<TaskCreateSuccessResult>
): Promise<TaskCreateSuccessResult> {
  if (!id) return create()
  let cache = pending.get(owners)
  if (!cache) {
    cache = new Map()
    pending.set(owners, cache)
  }
  const conflict = () =>
    new AppError(
      ErrorCode.IpcInvalidPayload,
      'Create request ID was reused with different input'
    )
  const known = cache.get(id)
  if (known)
    return known.fingerprint === fingerprint
      ? known.result
      : Promise.reject(conflict())
  for (const task of owners.getAll()) {
    const receipt = task.instances.find(
      (instance) => instance.payload?.createRequestId === id
    )?.payload
    if (!receipt) continue
    if (receipt.createRequestFingerprint !== fingerprint)
      return Promise.reject(conflict())
    return Promise.resolve({
      outcome: 'reused',
      taskId: task.id,
      gid: task.engineTaskId || task.id,
    })
  }
  const result = Promise.resolve().then(create)
  cache.set(id, { fingerprint, result })
  // The durable task graph owns settled receipts. Pending calls are never evicted.
  void result.finally(() => cache.delete(id)).catch(() => undefined)
  return result
}
