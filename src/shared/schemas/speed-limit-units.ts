import { z } from 'zod'
import { settingsInputObject } from './settings-input'

export const speedLimitUnitSchema = z.enum(['kilo', 'mega'])
export type SpeedLimitUnit = z.infer<typeof speedLimitUnitSchema>

// Store magnitude separately from byte rates and the global decimal/binary family.
export const speedLimitUnitsSchema = z.object({
  baseUpload: speedLimitUnitSchema.catch('kilo'),
  baseDownload: speedLimitUnitSchema.catch('kilo'),
  altUpload: speedLimitUnitSchema.catch('kilo'),
  altDownload: speedLimitUnitSchema.catch('kilo'),
})
export type SpeedLimitUnits = z.infer<typeof speedLimitUnitsSchema>
export const speedLimitUnitsInputSchema = settingsInputObject(
  speedLimitUnitsSchema
)
