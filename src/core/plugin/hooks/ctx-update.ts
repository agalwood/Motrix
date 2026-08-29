import path from 'node:path'
import {
  extractAria2ProxyCredentials,
  normalizeAria2TaskProxyUrl,
} from '@core/proxy/aria2-proxy-routing'
import { AppError, ErrorCode } from '@shared/errors'
import { z } from 'zod'
import type { RoleBand } from './role-band'

const taskProxySchema = z
  .string()
  .refine(
    (value) =>
      value === '' ||
      (normalizeAria2TaskProxyUrl(value) !== null &&
        extractAria2ProxyCredentials(value) !== null),
    { message: 'must be an aria2-compatible HTTP or HTTPS task proxy' }
  )

export const HttpPatchSchema = z
  .object({
    uris: z.array(z.string().url()).optional(),
    filename: z
      .string()
      .refine(
        (s) =>
          !s.includes('/') &&
          !s.includes('\\') &&
          s !== '..' &&
          !s.startsWith('.'),
        { message: 'must be a basename' }
      )
      .optional(),
    connections: z.number().int().min(1).max(16).optional(),
    headers: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .optional(),
    proxy: taskProxySchema.optional(),
  })
  .strict()

export const FinalizePatchSchema = z
  .object({
    filePath: z.string(),
  })
  .strict()

export interface ValidateOptions {
  permissions: ReadonlySet<string>
  role: RoleBand
  hook: 'beforeCreate' | 'beforeFinalize'
  saveDir: string
}

export function validateHttpPatch(
  patch: unknown,
  opts: ValidateOptions
): z.infer<typeof HttpPatchSchema> {
  if (opts.role === 'audit')
    throw new AppError(ErrorCode.PluginRuntimeFault, 'AuditRoleCannotMutate')
  const parsed = HttpPatchSchema.safeParse(patch)
  if (!parsed.success)
    throw new AppError(
      ErrorCode.PluginRuntimeFault,
      `CtxUpdateInvalid: ${parsed.error.issues[0]?.message ?? 'invalid patch'}`
    )
  if (
    parsed.data.filename !== undefined &&
    !opts.permissions.has('fs.task.write')
  )
    throw new AppError(
      ErrorCode.PluginRuntimeFault,
      'CtxUpdateInvalid: filename requires fs.task.write permission'
    )
  return parsed.data
}

export function validateFinalizePatch(
  patch: unknown,
  opts: ValidateOptions
): z.infer<typeof FinalizePatchSchema> {
  if (opts.role === 'audit')
    throw new AppError(ErrorCode.PluginRuntimeFault, 'AuditRoleCannotMutate')
  const parsed = FinalizePatchSchema.safeParse(patch)
  if (!parsed.success)
    throw new AppError(
      ErrorCode.PluginRuntimeFault,
      `CtxUpdateInvalid: ${parsed.error.issues[0]?.message ?? 'invalid patch'}`
    )
  // Normalize trailing separators so /downloads/ does not produce /downloads//
  const base = opts.saveDir.replace(/[/\\]+$/, '')
  const resolved = path.resolve(base, parsed.data.filePath)
  // Invariant I31: filePath must not escape the saveDir sandbox
  if (!resolved.startsWith(base + path.sep) && resolved !== base)
    throw new AppError(
      ErrorCode.PluginRuntimeFault,
      'CtxUpdateInvalid: filePath escapes saveDir'
    )
  return parsed.data
}
