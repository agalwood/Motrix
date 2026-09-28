import { z } from 'zod'

export const sidebarColorSchema = z.enum([
  'auto',
  'blue',
  'violet',
  'pink',
  'orange',
  'gold',
  'green',
  'cyan',
  'gray',
])

export type SidebarColor = z.infer<typeof sidebarColorSchema>
