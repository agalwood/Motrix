import { useTaskPieces } from '@renderer/hooks/use-task-pieces'
import { formatBytes } from '@renderer/lib/format'
import type { DownloadTask } from '@shared/types/task'
import { TaskStatus } from '@shared/types/task'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

// Statuses where the bitfield is actively changing and warrants the 2s
// polling cadence. For other statuses (paused / seeding / completed /
// error / removed) the hook still fetches once on mount so the user sees
// an available last-known piece map — it just stops polling after that.
// For completed tasks evicted from aria2, the query handler synthesizes a
// full-complete piece map from task.pieceLength + totalBytes, so this renders an
// all-green canvas without needing to know about the eviction here.
const PIECES_LIVE_STATUSES = new Set<TaskStatus>([
  TaskStatus.FetchingMetadata,
  TaskStatus.Downloading,
  TaskStatus.Finalizing,
])

type PieceState = 'done' | 'pending'

function statesFromBitfield(bitfield: string, numPieces: number): PieceState[] {
  const out: PieceState[] = []
  for (let i = 0; i < numPieces; i++) {
    const byteIndex = i >> 2
    const hex = bitfield[byteIndex]
    if (!hex) {
      out.push('pending')
      continue
    }
    const nibble = Number.parseInt(hex, 16)
    const bit = 3 - (i & 3)
    out.push((nibble >> bit) & 1 ? 'done' : 'pending')
  }
  return out
}

function downsample(states: PieceState[], target = 4000): PieceState[] {
  if (states.length <= target) return states
  const stride = Math.ceil(states.length / target)
  const out: PieceState[] = []
  for (let i = 0; i < states.length; i += stride) {
    const chunk = states.slice(i, i + stride)
    const done = chunk.filter((s) => s === 'done').length
    out.push(done * 2 >= chunk.length ? 'done' : 'pending')
  }
  return out
}

const CELL_PX = 4
const GAP_PX = 1
const COLOR_DONE = '#22c55e' // tailwind green-500
const COLOR_PENDING_FALLBACK = '#e5e7eb' // tailwind gray-200
// Reserves vertical space so the inspector doesn't reflow when `pieces` is
// briefly null during taskId switches or while the first poll resolves.
const PIECES_MIN_H_CLASS = 'min-h-[105px]'

function readColors(canvas: HTMLCanvasElement): {
  done: string
  pending: string
} {
  // Read theme tokens at draw time so light/dark mode is honored. The
  // fallback hex covers test envs (jsdom) where computed styles return
  // empty strings.
  const styles = getComputedStyle(canvas)
  const done = COLOR_DONE
  const pending =
    styles.getPropertyValue('--muted').trim() || COLOR_PENDING_FALLBACK
  return { done, pending }
}

function drawPieces(
  canvas: HTMLCanvasElement,
  cells: readonly PieceState[],
  cssWidth: number
): void {
  const stride = CELL_PX + GAP_PX
  const cols = Math.max(1, Math.floor((cssWidth + GAP_PX) / stride))
  const rows = Math.ceil(cells.length / cols)
  const cssHeight = Math.max(stride, rows * stride - GAP_PX)
  const dpr = window.devicePixelRatio || 1
  const targetW = Math.round(cssWidth * dpr)
  const targetH = Math.round(cssHeight * dpr)

  // Reassigning width/height clears the canvas AND reallocates its pixel
  // buffer (expensive). Skip when the dims are unchanged — a pure
  // cells-change repaint at the same width keeps the buffer.
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW
    canvas.height = targetH
    canvas.style.width = `${cssWidth}px`
    canvas.style.height = `${cssHeight}px`
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, cssWidth, cssHeight)

  const { done, pending } = readColors(canvas)
  ctx.fillStyle = pending
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== 'pending') continue
    const col = i % cols
    const row = (i / cols) | 0
    ctx.fillRect(col * stride, row * stride, CELL_PX, CELL_PX)
  }
  ctx.fillStyle = done
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== 'done') continue
    const col = i % cols
    const row = (i / cols) | 0
    ctx.fillRect(col * stride, row * stride, CELL_PX, CELL_PX)
  }
}

export function PiecesTab({ task }: { task: DownloadTask }) {
  const { t } = useTranslation()
  const { pieces } = useTaskPieces(
    task.id,
    PIECES_LIVE_STATUSES.has(task.status)
  )

  // Memoize on the bitfield primitive (not the pieces object) so the
  // 2s polling refresh's new TaskPiecesResult identity doesn't churn
  // a 4000-cell rebuild when the underlying bytes are unchanged.
  const bitfield = pieces?.bitfield ?? ''
  const numPieces = pieces?.numPieces ?? 0
  const cells = useMemo(
    () =>
      numPieces === 0
        ? []
        : downsample(statesFromBitfield(bitfield, numPieces)),
    [bitfield, numPieces]
  )

  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container || cells.length === 0) return
    let raf = 0
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const w = container.clientWidth
        if (w > 0) drawPieces(canvas, cells, w)
      })
    }
    schedule()
    // jsdom lacks ResizeObserver; the initial schedule() above is enough for tests.
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(schedule)
        : null
    ro?.observe(container)
    return () => {
      cancelAnimationFrame(raf)
      ro?.disconnect()
    }
  }, [cells])

  const doneCount = useMemo(
    () => cells.reduce((n, c) => (c === 'done' ? n + 1 : n), 0),
    [cells]
  )

  if (!pieces) {
    return <div aria-hidden="true" className={PIECES_MIN_H_CLASS} />
  }

  if (pieces.numPieces === 0) {
    return (
      <p
        className={`${PIECES_MIN_H_CLASS} p-6 text-center text-sm text-muted-foreground`}
      >
        {t('panel.downloads.inspector.pieces.empty')}
      </p>
    )
  }

  return (
    <div
      dir="ltr"
      style={{ direction: 'ltr' }}
      data-testid="pieces-root"
      className={`flex w-full gap-4 ${PIECES_MIN_H_CLASS}`}
    >
      <div ref={containerRef} className="min-w-0 flex-1 overflow-hidden">
        <canvas
          ref={canvasRef}
          data-piece-count={cells.length}
          aria-label={t('panel.downloads.inspector.pieces.mapLabel')}
          className="block max-w-full"
        />
      </div>
      <div className="w-40 shrink-0 space-y-1 text-[11px] text-muted-foreground">
        <p className="flex items-center gap-1">
          <span className="me-1 inline-block size-2.5 rounded-[2px] bg-green-500" />
          <span>{t('panel.downloads.inspector.pieces.legend.done')}</span>
          <span>{doneCount}</span>
        </p>
        <p className="flex items-center gap-1">
          <span className="me-1 inline-block size-2.5 rounded-[2px] bg-muted" />
          <span>{t('panel.downloads.inspector.pieces.legend.pending')}</span>
          <span>{cells.length - doneCount}</span>
        </p>
        <p className="flex items-center gap-1 mt-3 text-muted-foreground/80">
          <span>{t('panel.downloads.inspector.pieces.pieceLength')}:</span>
          <span>{formatBytes(pieces.pieceLength)}</span>
        </p>
        <p className="flex items-center gap-1 text-muted-foreground/80">
          <span>{t('panel.downloads.inspector.pieces.totalPieces')}:</span>
          <span>{pieces.numPieces}</span>
        </p>
      </div>
    </div>
  )
}
