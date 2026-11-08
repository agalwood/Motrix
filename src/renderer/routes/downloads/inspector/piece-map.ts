export type PieceState = 'done' | 'pending'

const MAX_CELLS = 4_000
const POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4]

function nibble(code: number): number {
  if (code >= 48 && code <= 57) return code - 48
  if (code >= 65 && code <= 70) return code - 55
  if (code >= 97 && code <= 102) return code - 87
  return 0
}

/** Aggregate directly from MSB-first hex, allocating only the visible cells. */
export function aggregatePieceMap(
  bitfield: string,
  numPieces: number
): {
  cells: PieceState[]
  donePieces: number
  pendingPieces: number
} {
  if (!Number.isSafeInteger(numPieces) || numPieces <= 0) {
    return { cells: [], donePieces: 0, pendingPieces: 0 }
  }
  const stride = Math.ceil(numPieces / MAX_CELLS)
  const availablePieces = Math.min(numPieces, bitfield.length * 4)
  const cells: PieceState[] = []
  let donePieces = 0
  for (let start = 0; start < numPieces; start += stride) {
    const end = Math.min(start + stride, numPieces)
    const availableEnd = Math.min(end, availablePieces)
    let done = 0
    for (let cursor = start; cursor < availableEnd; ) {
      const offset = cursor % 4
      const count = Math.min(4 - offset, availableEnd - cursor)
      const mask = ((1 << count) - 1) << (4 - offset - count)
      done +=
        POPCOUNT[nibble(bitfield.charCodeAt(Math.floor(cursor / 4))) & mask]
      cursor += count
    }
    donePieces += done
    // Preserve the existing majority coloring, including ties and the short
    // final bucket. Padding and missing bits never count as completed pieces.
    cells.push(done * 2 >= end - start ? 'done' : 'pending')
  }
  return { cells, donePieces, pendingPieces: numPieces - donePieces }
}
