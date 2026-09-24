import { probePrecise } from '@core/probe/disk-probe'
import type { TuningContext } from '@shared/types/tuning'
import { recommend } from './aria2/aria2-tuning'

export interface GetTuningRecommendationParams {
  downloadPath: string
  totalSizeBytes?: number
  protocol?: string
  isMultiFile?: boolean
}

export async function getTuningRecommendation(
  params: GetTuningRecommendationParams
) {
  const probe = await probePrecise(params.downloadPath)
  const context: TuningContext = {
    downloadPath: params.downloadPath,
    totalSizeBytes: params.totalSizeBytes ?? null,
    protocol: (params.protocol as TuningContext['protocol']) ?? 'http',
    isMultiFile: params.isMultiFile ?? null,
  }
  return recommend(probe, context)
}
