import { ElectronTransport } from './electron'
import { HttpWsTransport } from './http-ws'
import type { Transport } from './types'

function createTransport(): Transport {
  if (__MOTRIX_TARGET__ === 'electron') return new ElectronTransport()
  return new HttpWsTransport(globalThis.location?.origin ?? '')
}

export const transport: Transport = createTransport()
export type { Transport } from './types'
