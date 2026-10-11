import {
  BoundedJsonSchemaTopLevel,
  boundedOperationJson,
  OperationDefinitionSchema,
} from '@motrix/plugin-manifest-schema'
import { z } from 'zod'

const id = z.string().uuid()
const field = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
const values = z
  .unknown()
  .refine(
    (value) => boundedOperationJson(value, 131072, 2),
    'operation values exceed limits'
  )
  .pipe(
    z.record(
      field,
      z.union([z.string().max(4096), z.number().finite(), z.boolean()])
    )
  )
  .refine(
    (value) => Object.keys(value).length <= 24,
    'too many operation values'
  )
export const operationPrepareSchema = z.strictObject({
  pluginId: z.string().min(1).max(140),
  operationId: z.string().min(1).max(228),
  repeatJobId: id.optional(),
  resume: z.boolean().optional(),
  taskIds: z.array(z.string().min(1).max(128)).max(4).optional(),
})
export const operationPickSchema = z.strictObject({
  draftId: id,
  field,
  values,
  candidate: z.string().min(1).max(4096).optional(),
})
export const operationUpdateSchema = operationPickSchema.pick({
  draftId: true,
  values: true,
})
export const operationStartSchema = z.strictObject({
  draftId: id,
  idempotencyKey: id,
  descriptorRevision: z.string().length(64),
  args: values,
})
export const operationIdSchema = id
export const operationFileViewSchema = z.strictObject({
  ref: id,
  name: z.string().max(256),
  location: z.string().max(4096),
})
export const operationDescriptorSchema = z.strictObject({
  pluginId: z.string(),
  pluginName: z.string(),
  pluginVersion: z.string(),
  descriptorRevision: z.string().length(64),
  definition: OperationDefinitionSchema,
  argsSchema: BoundedJsonSchemaTopLevel,
  resultSchema: BoundedJsonSchemaTopLevel,
  unavailable: z
    .enum(['disabled', 'blocked', 'unsupported', 'ffmpeg', 'busy'])
    .optional(),
})
export type OperationDescriptor = z.infer<typeof operationDescriptorSchema>
export const operationJobSchema = z.strictObject({
  id,
  pluginId: z.string(),
  operationId: z.string(),
  pluginName: z.string(),
  title: z.string(),
  status: z.enum([
    'accepted',
    'preparing',
    'running',
    'validating',
    'committing',
    'cleaning',
    'cancelling',
    'succeeded',
    'cancelled',
    'failed',
    'interrupted',
  ]),
  percent: z.number().min(0).max(100).nullable(),
  sequence: z.number().int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
  error: z.string().max(128).optional(),
  result: values.optional(),
  outputs: z
    .array(
      z.strictObject({
        id,
        name: z.string().max(256),
        location: z.string().max(4096).optional(),
      })
    )
    .max(1),
  cleanupWarning: z.boolean().optional(),
})
export type OperationJob = z.infer<typeof operationJobSchema>
export type OperationFileView = z.infer<typeof operationFileViewSchema>
export interface OperationDraft {
  id: string
  descriptor: OperationDescriptor
  args: Record<string, string | number | boolean>
  files: Record<string, OperationFileView>
  suggestions?: Record<string, string>
  expiresAt: number
}
export const isOperationTerminal = (status: OperationJob['status']) =>
  ['succeeded', 'cancelled', 'failed', 'interrupted'].includes(status)
