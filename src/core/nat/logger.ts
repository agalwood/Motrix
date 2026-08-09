import { getLogger } from '@core/logger'
import type pino from 'pino'

// Produces a child logger keyed module: 'nat.<sub>' for structured log filtering.
export function natLogger(sub: string): pino.Logger {
  return getLogger(`nat.${sub}`)
}
