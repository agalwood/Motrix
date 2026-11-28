import { z } from 'zod'

export const nasRootPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^\/[^:]+$/)
  .regex(/^\P{Cc}+$/u)
  .refine((value) =>
    value
      .split('/')
      .slice(1)
      .every((part) => part !== '' && part !== '.' && part !== '..')
  )

/** Host-owned package settings, separate from ordinary application preferences. */
export const nasPackageSettingsSchema = z
  .object({
    roots: z
      .array(nasRootPathSchema)
      .min(1)
      .max(64)
      .refine((values) => new Set(values).size === values.length),
    clientPort: z.number().int().min(1024).max(65535),
    extensionUrl: z.string().max(2048),
    operatorUrl: z.string().max(2048),
    allowHttp: z.boolean(),
  })
  .strict()
export type NasPackageSettings = z.infer<typeof nasPackageSettingsSchema>

export const nasSettingsViewSchema = z
  .object({
    platform: z.enum(['synology', 'fnos']),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    settings: nasPackageSettingsSchema,
    active: nasPackageSettingsSchema,
    restartRequired: z.boolean(),
  })
  .strict()
export type NasSettingsView = z.infer<typeof nasSettingsViewSchema>

export const saveNasSettingsSchema = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    settings: nasPackageSettingsSchema,
  })
  .strict()
export const nasSettingsErrorSchema = z.enum([
  'invalid',
  'folderUnavailable',
  'permissionDenied',
  'unavailable',
  'conflict',
])
export const nasSettingsResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value: nasSettingsViewSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: nasSettingsErrorSchema }).strict(),
    })
    .strict(),
])
export type NasSettingsResult = z.infer<typeof nasSettingsResultSchema>

export function synologyConnectionUrls(origin: string) {
  const url = new URL(origin)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.origin !== origin
  )
    throw new Error('Invalid DSM origin')
  return {
    operatorUrl: `${origin}/motrix/`,
    extensionUrl: `${origin.replace(/^http/, 'ws')}/motrix/bridge`,
  }
}
