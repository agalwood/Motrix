import { z } from 'zod'

const component = z
  .string()
  .min(1)
  .refine(
    (value) => value !== '.' && value !== '..' && !/[\\/\0]/.test(value),
    'Invalid torrent path component'
  )
const bytes = z.number().int().nonnegative().safe()

/** Verified engine info; missing download proofs are represented explicitly. */
export const torrentManifestSchema = z
  .object({
    infoHash: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    v1: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
    v2: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    name: component,
    multiFile: z.boolean(),
    isPrivate: z.boolean(),
    verificationReady: z.boolean(),
    files: z
      .array(
        z.object({
          index: bytes,
          components: z.array(component).min(1),
          length: bytes,
          padding: z.boolean(),
        })
      )
      .min(1)
      .max(1_000_000),
  })
  .refine(
    (manifest) =>
      manifest.infoHash === (manifest.v1 ?? manifest.v2) &&
      manifest.files.some((file) => !file.padding) &&
      Number.isSafeInteger(
        manifest.files.reduce((sum, file) => sum + file.length, 0)
      ) &&
      manifest.files.every(
        (file, index) =>
          file.index === index &&
          file.components[0] === manifest.name &&
          (manifest.multiFile
            ? file.components.length > 1
            : file.components.length === 1)
      ) &&
      (manifest.multiFile || manifest.files.length === 1),
    'Inconsistent torrent identity or file layout'
  )

export type TorrentManifest = z.infer<typeof torrentManifestSchema>

/** Internal provenance for replaying an info-only sidecar after a restart. */
export const torrentManifestRecordSchema = z.object({
  metadataSha256: z.string().regex(/^[a-f0-9]{64}$/),
  manifest: torrentManifestSchema,
})
export type TorrentManifestRecord = z.infer<typeof torrentManifestRecordSchema>

export const torrentManifestReferenceSchema = z.object({
  version: z.literal(1),
  metadataSha256: z.string().regex(/^[a-f0-9]{64}$/),
  previousPath: z.string().optional(),
})

export const torrentManifestResponseSchema = z.object({
  data: z.string().min(1),
  awaitingSelection: z.boolean(),
  manifest: torrentManifestSchema,
})
