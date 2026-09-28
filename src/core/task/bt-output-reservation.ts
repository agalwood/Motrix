import path from 'node:path'
import type { DownloadTask } from '@shared/types/task'

export interface BtOutputReservation {
  finalPath: string
  infoHash: string
  multiFile?: boolean
}

/** Includes older single-reservation rows and failed attempts at other targets. */
export function getBtOutputReservations(
  task: Pick<DownloadTask, 'instances'>
): BtOutputReservation[] {
  const reservations = new Map<string, BtOutputReservation>()
  for (const instance of task.instances ?? []) {
    const payload = instance.payload ?? {}
    const values = [
      payload.btOutputReservation,
      ...(Array.isArray(payload.btOutputReservations)
        ? payload.btOutputReservations
        : []),
    ]
    for (const value of values) {
      if (!value || typeof value !== 'object') continue
      const reservation = value as Partial<BtOutputReservation>
      if (
        typeof reservation.finalPath === 'string' &&
        path.isAbsolute(reservation.finalPath) &&
        path.resolve(reservation.finalPath) !==
          path.parse(reservation.finalPath).root &&
        typeof reservation.infoHash === 'string' &&
        /^[a-f0-9]{40}$/i.test(reservation.infoHash)
      )
        reservations.set(
          reservation.finalPath,
          reservation as BtOutputReservation
        )
    }
  }
  return [...reservations.values()]
}
