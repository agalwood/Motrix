import type { Aria2RawStatus } from './types'

// Keep lifecycle, error and BT classification fields even when no inspector is
// open. `files` is synchronized separately; bitfield/peers belong to detail APIs.
export const TASK_STATUS_FIELDS = [
  'gid',
  'status',
  'totalLength',
  'completedLength',
  'uploadLength',
  'downloadSpeed',
  'uploadSpeed',
  'connections',
  'numSeeders',
  'seeder',
  'pieceLength',
  'numPieces',
  'dir',
  'bittorrent',
  'infoHash',
  'errorCode',
  'errorMessage',
  'followedBy',
  'following',
  'belongsTo',
] satisfies Array<keyof Aria2RawStatus>
