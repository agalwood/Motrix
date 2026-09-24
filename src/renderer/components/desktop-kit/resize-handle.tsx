import { useRef } from 'react'

interface ResizeHandleProps {
  label: string
  orientation: 'horizontal' | 'vertical'
  value: number
  min: number
  max: number
  /** A bottom pane grows upwards; a column grows to the right. */
  reverse?: boolean
  className?: string
  onChange: (value: number) => void
  onCommit: (value: number) => void
}

export function ResizeHandle({
  label,
  orientation,
  value,
  min,
  max,
  reverse,
  className,
  onChange,
  onCommit,
}: ResizeHandleProps) {
  const drag = useRef<{
    coordinate: number
    value: number
    current: number
  } | null>(null)
  const clamp = (next: number) => Math.round(Math.max(min, Math.min(max, next)))
  return (
    // biome-ignore lint/a11y/useSemanticElements: Interactive window splitter, not a thematic break.
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      className={className}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = {
          coordinate:
            orientation === 'vertical' ? event.clientX : event.clientY,
          value,
          current: value,
        }
      }}
      onPointerMove={(event) => {
        const start = drag.current
        if (!start) return
        const coordinate =
          orientation === 'vertical' ? event.clientX : event.clientY
        start.current = clamp(
          start.value + (coordinate - start.coordinate) * (reverse ? -1 : 1)
        )
        onChange(start.current)
      }}
      onPointerUp={(event) => {
        if (!drag.current) return
        onCommit(drag.current.current)
        drag.current = null
        event.currentTarget.releasePointerCapture(event.pointerId)
      }}
      onPointerCancel={() => {
        if (drag.current) onChange(drag.current.value)
        drag.current = null
      }}
      onKeyDown={(event) => {
        event.stopPropagation()
        const decrease = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowDown'
        const increase = orientation === 'vertical' ? 'ArrowRight' : 'ArrowUp'
        if (![decrease, increase, 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        onCommit(
          event.key === 'Home'
            ? min
            : event.key === 'End'
              ? max
              : clamp(value + (event.key === increase ? 16 : -16))
        )
      }}
    />
  )
}
