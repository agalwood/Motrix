import type { z } from 'zod'
import type { engineTaskOptionsSchema } from '../schemas/engine-task-options'

export type EngineTaskOptions = z.infer<typeof engineTaskOptionsSchema>
