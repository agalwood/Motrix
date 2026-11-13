import { engineSettingsInputSchema } from './engine-settings'

/** Runtime settings owned by the current engine. Legacy import preferences stay in storage. */
export const publicEngineSettingsSchema = engineSettingsInputSchema.omit({
  dnsMode: true,
  lowestSpeedLimit: true,
  fileAllocation: true,
  diskCache: true,
  sqlite3Persistence: true,
  sqlite3DbPath: true,
  sqlite3HistoryLimit: true,
})
