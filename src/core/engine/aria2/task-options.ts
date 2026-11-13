import { formatFileSelection } from '@shared/lib/file-selection-ranges'
import { engineTaskOptionsSchema } from '@shared/schemas/engine-task-options'
import type { EngineTaskOptions } from '@shared/types/engine-task-options'
import type { FileAllocation } from '@shared/types/tuning'
import { z } from 'zod'
import type { AddTorrentParams, CreateDownloadParams } from '../engine-adapter'

const wireOptions = z.record(
  z.string(),
  z.union([z.string(), z.array(z.string())])
)
export type Aria2TaskOptions = z.infer<typeof wireOptions>
export const parseTaskOptions = (raw: unknown): Aria2TaskOptions =>
  wireOptions.parse(raw)

/** Decode only the request details used by Motrix. Unknown options stay private. */
export function decodeTaskOptions(raw: unknown): EngineTaskOptions {
  const options = parseTaskOptions(raw)
  const text = (key: string) =>
    typeof options[key] === 'string' ? (options[key] as string) : undefined
  const lines = [options.header ?? []]
    .flat()
    .flatMap((value) => value.split(/\r?\n/))
  const headers = lines.flatMap((line) => {
    const colon = line.indexOf(':')
    if (colon < 1) return []
    const name = line.slice(0, colon).trim()
    return name ? [{ name, value: line.slice(colon + 1).trim() }] : []
  })
  const count = text('split') ? Number(text('split')) : undefined
  return engineTaskOptionsSchema.parse({
    connections:
      Number.isSafeInteger(count) && (count ?? 0) > 0 ? count : undefined,
    headers,
    userAgent: text('user-agent'),
    referrer: text('referer'),
    proxyUrl: text('all-proxy'),
  })
}

/** Domain indices are zero based. Wire conversion belongs to the adapter. */
export function encodeFileSelection(indices: readonly number[]): string {
  if (
    !indices.length ||
    indices.some((index) => !Number.isSafeInteger(index) || index < 0)
  ) {
    throw new TypeError('Select at least one valid file index')
  }
  return formatFileSelection(indices, 0)
}

/** Adapter-internal overrides for native protocol operations and protocol tests. */
export type RpcDownloadParams = CreateDownloadParams & {
  fileAllocation?: FileAllocation
  wireOptions?: Record<string, string | string[]>
}
export type RpcTorrentParams = AddTorrentParams & {
  wireOptions?: Record<string, string | string[]>
}
