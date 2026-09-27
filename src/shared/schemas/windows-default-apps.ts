import { z } from 'zod'
import { WindowsPlatformClientErrorSchema } from './windows-platform'

// The helper verifies the OS-provided family against the main manifest entry.
// This boundary only validates its representation; it does not attest a
// publisher. AppId is fixed to Motrix, including for the isolated test package.
export const WindowsMainAppAumidSchema = z
  .string()
  .regex(/^[A-Za-z0-9.-]{3,50}_[a-hjkmnp-tv-zA-HJKMNP-TV-Z0-9]{13}!Motrix$/)

export const WindowsAssociationsRequestSchema = z
  .object({ version: z.literal(1), op: z.literal('associations_query') })
  .strict()

export const WindowsAssociationsResponseSchema = z.discriminatedUnion('ok', [
  z
    .object({
      version: z.literal(1),
      ok: z.literal(true),
      packageIdentityPresent: z.literal(true),
      mainAppAumid: WindowsMainAppAumidSchema,
      torrent: z.boolean().nullable(),
      magnet: z.boolean().nullable(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      ok: z.literal(false),
      code: z.enum([
        'invalid_request',
        'no_package_identity',
        'main_app_unavailable',
        'winrt_failed',
      ]),
      hresult: z
        .string()
        .regex(/^0x[0-9a-fA-F]{8}$/)
        .optional(),
    })
    .strict(),
])

export const WindowsAssociationsResultSchema = z.union([
  WindowsAssociationsResponseSchema,
  WindowsPlatformClientErrorSchema,
])

const traditionalAssociationsSchema = z
  .object({
    supported: z.boolean(),
    registered: z.boolean().nullable(),
    scope: z.enum(['user', 'machine']).nullable(),
    torrent: z.boolean().nullable(),
    magnet: z.boolean().nullable(),
  })
  .strict()

const packagedAssociationsSchema = traditionalAssociationsSchema
  .extend({
    authority: z.literal('windows-package'),
    supported: z.literal(true),
    // These fields describe the traditional installer registration only.
    registered: z.null(),
    scope: z.null(),
    mainAppAumid: WindowsMainAppAumidSchema.nullable(),
  })
  .refine(
    (status) =>
      status.mainAppAumid !== null ||
      (status.torrent === null && status.magnet === null)
  )

export const WindowsDefaultAssociationsSchema = z.union([
  traditionalAssociationsSchema,
  packagedAssociationsSchema,
])

export type WindowsAssociationsResult = z.infer<
  typeof WindowsAssociationsResultSchema
>
export type WindowsDefaultAssociations = z.infer<
  typeof WindowsDefaultAssociationsSchema
>
