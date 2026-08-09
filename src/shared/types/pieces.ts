/**
 * BT piece state for a single task.
 *
 * For non-BT tasks (HTTP/FTP/SFTP) the engine returns no piece info;
 * this type uses zero-shape values rather than nulls so callers don't
 * have to branch on task type.
 */
export interface TaskPiecesResult {
  /** Bytes per piece. 0 when the engine has no piece concept. */
  pieceLength: number
  /** Total piece count. 0 for non-BT tasks. */
  numPieces: number
  /**
   * Hex-encoded bitfield from aria2 `tellStatus.bitfield`.
   * Each hex char encodes 4 pieces (MSB = piece i, LSB = piece i+3).
   * Empty string for non-BT tasks.
   */
  bitfield: string
}
