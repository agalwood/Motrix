/** Piece state for a single engine-backed download task. */
export interface TaskPiecesResult {
  /** Bytes per piece. 0 until the engine knows the piece layout. */
  pieceLength: number
  /** Total piece count. 0 until the engine knows the content length. */
  numPieces: number
  /**
   * Hex-encoded bitfield from aria2 `tellStatus.bitfield`.
   * Each hex char encodes 4 pieces (MSB = piece i, LSB = piece i+3).
   * Empty while the download has not started or no live map is available.
   */
  bitfield: string
}
