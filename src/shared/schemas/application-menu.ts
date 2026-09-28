import { z } from 'zod'
import { CommandIds } from '../commands-catalog'

export const applicationMenuNodeTypeSchema = z.enum([
  'normal',
  'submenu',
  'separator',
  'checkbox',
  'radio',
])

const menuItemIdSchema = z.string().min(1).max(256)

const applicationMenuNodeFieldsSchema = z
  .object({
    id: menuItemIdSchema,
    type: applicationMenuNodeTypeSchema,
    label: z.string(),
    accelerator: z.string().min(1).optional(),
    enabled: z.boolean(),
    visible: z.boolean(),
    checked: z.boolean().optional(),
    radioGroupId: menuItemIdSchema.optional(),
  })
  .strict()

type ApplicationMenuNodeFields = z.infer<typeof applicationMenuNodeFieldsSchema>

export interface ApplicationMenuNode extends ApplicationMenuNodeFields {
  children?: ApplicationMenuNode[]
}

export const applicationMenuNodeSchema: z.ZodType<ApplicationMenuNode> = z.lazy(
  () =>
    applicationMenuNodeFieldsSchema
      .extend({
        children: z.array(applicationMenuNodeSchema).optional(),
      })
      .superRefine((node, context) => {
        const checkable = node.type === 'checkbox' || node.type === 'radio'
        if (checkable && node.checked === undefined) {
          context.addIssue({
            code: 'custom',
            message: `${node.type} nodes require checked state`,
          })
        }
        if ((node.type === 'radio') !== Boolean(node.radioGroupId)) {
          context.addIssue({
            code: 'custom',
            message: 'radio nodes require an exclusive radioGroupId',
          })
        }
        if ((node.type === 'submenu') !== Boolean(node.children)) {
          context.addIssue({
            code: 'custom',
            message: 'only submenu nodes may contain children',
          })
        }
      })
)

export const applicationMenuSnapshotSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    items: z.array(applicationMenuNodeSchema),
  })
  .strict()

export type ApplicationMenuSnapshot = z.infer<
  typeof applicationMenuSnapshotSchema
>

export const applicationMenuModifiersSchema = z
  .object({
    alt: z.boolean(),
    control: z.boolean(),
    meta: z.boolean(),
    shift: z.boolean(),
  })
  .strict()

export const executeApplicationMenuItemRequestSchema = z
  .object({
    itemId: menuItemIdSchema,
    revision: z.number().int().nonnegative(),
    trigger: z.literal('menu'),
    selectedTaskGeneration: z.number().int().nonnegative().optional(),
    selectedTaskId: z.string().min(1).nullable(),
    modifiers: applicationMenuModifiersSchema.optional(),
  })
  .strict()

export type ExecuteApplicationMenuItemRequest = z.infer<
  typeof executeApplicationMenuItemRequestSchema
>

export const rendererTaskMenuRequestSchema = z
  .object({
    commandId: z.enum([
      CommandIds.TaskPause,
      CommandIds.TaskResume,
      CommandIds.TaskDelete,
      CommandIds.TaskMoveUp,
      CommandIds.TaskMoveDown,
      CommandIds.TaskClearStopped,
    ]),
    taskIds: z.array(z.string().min(1)),
    generation: z.number().int().nonnegative(),
  })
  .strict()
