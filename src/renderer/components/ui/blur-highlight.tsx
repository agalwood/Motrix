import { cn } from '@renderer/lib/utils'
import {
  type CSSProperties,
  type ElementType,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

export interface HighlightedBit {
  text: string
  /** One-based occurrence. Omit to highlight every occurrence. */
  occurrence?: number
}

export interface BlurHighlightViewportOptions {
  once?: boolean
  amount?: number
}

export interface BlurHighlightProps {
  as?: ElementType
  children: string
  highlightedBits: Array<string | HighlightedBit>
  highlightColor?: string
  highlightClassName?: string
  blurAmount?: number
  inactiveOpacity?: number
  blurDelay?: number
  blurDuration?: number
  highlightDelay?: number
  highlightDuration?: number
  highlightDirection?: 'left' | 'right' | 'top' | 'bottom'
  viewportOptions?: BlurHighlightViewportOptions
  className?: string
}

interface TextSegment {
  end: number
  highlighted: boolean
  start: number
}

type BlurHighlightStyle = CSSProperties & {
  '--blur-highlight-blur': string
  '--blur-highlight-inactive-opacity': number
  '--blur-highlight-blur-delay': string
  '--blur-highlight-blur-duration': string
  '--blur-highlight-delay': string
  '--blur-highlight-duration': string
  '--blur-highlight-color': string
}

function findOccurrences(source: string, needle: string): number[] {
  if (needle.length === 0) return []

  const starts: number[] = []
  let from = 0
  while (from <= source.length - needle.length) {
    const start = source.indexOf(needle, from)
    if (start === -1) break
    starts.push(start)
    from = start + needle.length
  }
  return starts
}

function splitHighlightedText(
  source: string,
  highlightedBits: Array<string | HighlightedBit>
): TextSegment[] {
  const candidates: TextSegment[] = []

  for (const bit of highlightedBits) {
    const text = typeof bit === 'string' ? bit : bit.text
    const starts = findOccurrences(source, text)
    const selectedStarts =
      typeof bit === 'string' || bit.occurrence == null
        ? starts
        : [starts[bit.occurrence - 1]].filter(
            (start): start is number => start != null
          )

    for (const start of selectedStarts) {
      candidates.push({ start, end: start + text.length, highlighted: true })
    }
  }

  candidates.sort((a, b) => a.start - b.start || b.end - a.end)

  const segments: TextSegment[] = []
  let cursor = 0
  for (const candidate of candidates) {
    if (candidate.start < cursor) continue
    if (candidate.start > cursor) {
      segments.push({
        start: cursor,
        end: candidate.start,
        highlighted: false,
      })
    }
    segments.push(candidate)
    cursor = candidate.end
  }

  if (cursor < source.length) {
    segments.push({ start: cursor, end: source.length, highlighted: false })
  }

  return segments.length > 0
    ? segments
    : [{ start: 0, end: source.length, highlighted: false }]
}

export function BlurHighlight({
  as: Component = 'p',
  children,
  highlightedBits,
  highlightColor = '#171717',
  highlightClassName,
  blurAmount = 8,
  inactiveOpacity = 0.3,
  blurDelay = 0,
  blurDuration = 0.8,
  highlightDelay = 0.4,
  highlightDuration = 1,
  highlightDirection = 'left',
  viewportOptions,
  className,
}: BlurHighlightProps) {
  const rootRef = useRef<HTMLElement | null>(null)
  const [ready, setReady] = useState(false)
  const [inView, setInView] = useState(false)
  const once = viewportOptions?.once ?? false
  const amount = viewportOptions?.amount ?? 0.5

  const segments = useMemo(
    () => splitHighlightedText(children, highlightedBits),
    [children, highlightedBits]
  )

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    setReady(true)

    if (
      typeof window === 'undefined' ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ||
      typeof IntersectionObserver === 'undefined'
    ) {
      setInView(true)
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return
        if (entry.isIntersecting) {
          setInView(true)
          if (once) observer.unobserve(root)
          return
        }
        if (!once) setInView(false)
      },
      { rootMargin: '-20%', threshold: amount }
    )

    observer.observe(root)
    return () => observer.disconnect()
  }, [amount, once])

  const style: BlurHighlightStyle = {
    '--blur-highlight-blur': `${blurAmount}px`,
    '--blur-highlight-inactive-opacity': inactiveOpacity,
    '--blur-highlight-blur-delay': `${blurDelay}s`,
    '--blur-highlight-blur-duration': `${blurDuration}s`,
    '--blur-highlight-delay': `${highlightDelay}s`,
    '--blur-highlight-duration': `${highlightDuration}s`,
    '--blur-highlight-color': highlightColor,
  }

  const content: ReactNode = segments.map((segment) => {
    const text = children.slice(segment.start, segment.end)
    if (!segment.highlighted) return text

    return (
      <span
        key={`${segment.start}-${segment.end}`}
        data-slot="blur-highlight-bit"
        className={cn('blur-highlight-bit', highlightClassName)}
      >
        {text}
      </span>
    )
  })

  return (
    <Component
      ref={rootRef}
      data-slot="blur-highlight"
      data-ready={ready}
      data-in-view={inView}
      data-highlight-direction={highlightDirection}
      className={cn(
        'blur-highlight motion-reduce:opacity-100 motion-reduce:blur-none motion-reduce:transition-none',
        className
      )}
      style={style}
    >
      {content}
    </Component>
  )
}
