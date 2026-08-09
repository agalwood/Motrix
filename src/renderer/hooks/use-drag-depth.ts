import { type DragEvent, useCallback, useRef, useState } from 'react'

export interface DragHandlers<T extends HTMLElement> {
  onDragEnter: (e: DragEvent<T>) => void
  onDragLeave: (e: DragEvent<T>) => void
  onDragOver: (e: DragEvent<T>) => void
  onDrop: (e: DragEvent<T>) => void
}

export interface UseDragDepthResult<T extends HTMLElement> {
  isDragging: boolean
  dragHandlers: DragHandlers<T>
}

/**
 * Counter-based drag-enter/leave tracking to prevent flicker when dragging
 * over nested DOM elements. A naive dragenter/dragleave toggle flickers
 * because leaving a child fires dragleave even while still inside the parent.
 */
export function useDragDepth<T extends HTMLElement = HTMLDivElement>(
  onFilesDrop?: (files: FileList) => void
): UseDragDepthResult<T> {
  const depth = useRef(0)
  const [isDragging, setIsDragging] = useState(false)

  const onDragEnter = useCallback((e: DragEvent<T>) => {
    e.preventDefault()
    depth.current += 1
    if (depth.current === 1) setIsDragging(true)
  }, [])

  const onDragLeave = useCallback((e: DragEvent<T>) => {
    e.preventDefault()
    depth.current -= 1
    if (depth.current <= 0) {
      depth.current = 0
      setIsDragging(false)
    }
  }, [])

  const onDragOver = useCallback((e: DragEvent<T>) => {
    e.preventDefault()
  }, [])

  const onDrop = useCallback(
    (e: DragEvent<T>) => {
      e.preventDefault()
      depth.current = 0
      setIsDragging(false)
      if (onFilesDrop && e.dataTransfer.files.length > 0) {
        onFilesDrop(e.dataTransfer.files)
      }
    },
    [onFilesDrop]
  )

  return {
    isDragging,
    dragHandlers: { onDragEnter, onDragLeave, onDragOver, onDrop },
  }
}
