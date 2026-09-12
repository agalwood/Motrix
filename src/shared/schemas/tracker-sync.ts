import { z } from 'zod'

export const trackerSyncStatusSchema = z.enum([
  'idle',
  'fetching',
  'probing',
  'applying',
  'failed',
])

export type TrackerSyncStatus = z.infer<typeof trackerSyncStatusSchema>
