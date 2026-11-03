import type { Point, Rectangle } from 'electron'

interface DraggableWindow {
  getBounds(): Rectangle
  isDestroyed(): boolean
  setPosition(x: number, y: number, animate?: boolean): void
}

export interface ManualWindowDrag {
  move(point: Point): void
  stop(): void
}

export function beginManualWindowDrag(
  win: DraggableWindow,
  startCursor: Point
): ManualWindowDrag {
  const startBounds = win.getBounds()
  let stopped = false

  const stop = () => {
    stopped = true
  }

  return {
    move(point) {
      if (stopped) return
      if (win.isDestroyed()) {
        stop()
        return
      }

      const x = startBounds.x + point.x - startCursor.x
      const y = startBounds.y + point.y - startCursor.y
      if (x === startBounds.x && y === startBounds.y) return

      try {
        win.setPosition(x, y, false)
      } catch {
        stop()
      }
    },
    stop,
  }
}
