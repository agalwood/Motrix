import { getLogger } from '@core/logger'
import type pino from 'pino'

export function trackerLogger(sub: string): pino.Logger {
  return getLogger(`tracker.${sub}`)
}
