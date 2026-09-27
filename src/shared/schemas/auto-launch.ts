import { z } from 'zod'

export const WindowsStartupTaskStateSchema = z.enum([
  'disabled',
  'disabled_by_user',
  'enabled',
  'disabled_by_policy',
  'enabled_by_policy',
])

export const WindowsStartupTaskRequestSchema = z
  .object({
    version: z.literal(1),
    op: z.enum(['startup_query', 'startup_enable', 'startup_disable']),
  })
  .strict()

const successSchema = z
  .object({
    version: z.literal(1),
    ok: z.literal(true),
    taskId: z.literal('MotrixStartup'),
    state: WindowsStartupTaskStateSchema,
    packageIdentityPresent: z.literal(true),
  })
  .strict()

const helperErrorCodeSchema = z.enum([
  'invalid_request',
  'no_package_identity',
  'task_unavailable',
  'winrt_failed',
  'unknown_state',
])
const helperErrorSchema = z
  .object({
    version: z.literal(1),
    ok: z.literal(false),
    code: helperErrorCodeSchema,
    hresult: z
      .string()
      .regex(/^0x[0-9a-fA-F]{8}$/)
      .optional(),
  })
  .strict()

// Only the native helper's documented responses are accepted from stdout.
export const WindowsStartupTaskResponseSchema = z.discriminatedUnion('ok', [
  successSchema,
  helperErrorSchema,
])

export const WindowsStartupTaskResultSchema = z.discriminatedUnion('ok', [
  successSchema,
  helperErrorSchema.extend({
    code: z.enum([
      ...helperErrorCodeSchema.options,
      'helper_unavailable',
      'helper_failed',
      'helper_timeout',
      'output_limit',
      'invalid_response',
    ]),
  }),
])

export const AutoLaunchStatusSchema = z.discriminatedUnion('authority', [
  z.object({ authority: z.literal('application') }).strict(),
  z.object({ authority: z.literal('unsupported') }).strict(),
  z
    .object({
      authority: z.literal('windows-package'),
      result: WindowsStartupTaskResultSchema,
    })
    .strict(),
])

export const OpenStartupSettingsResultSchema = z
  .object({ ok: z.boolean() })
  .strict()

export type WindowsStartupTaskState = z.infer<
  typeof WindowsStartupTaskStateSchema
>
export type WindowsStartupTaskRequest = z.infer<
  typeof WindowsStartupTaskRequestSchema
>
export type WindowsStartupTaskResult = z.infer<
  typeof WindowsStartupTaskResultSchema
>
export type AutoLaunchStatus = z.infer<typeof AutoLaunchStatusSchema>
