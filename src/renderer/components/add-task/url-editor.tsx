import { InputGroupTextarea } from '@renderer/components/ui/input-group'
import type { DownloadInputLine } from '@shared/lib/download-source-input'
import type { SourceCorrection } from '@shared/schemas/download-source'
import {
  type ComponentProps,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { UrlDiagnostic } from './url-diagnostic'
import { getUrlDisplayParts, getUrlErrorRange } from './url-editor-presentation'
import './url-editor.css'

interface UrlEditorProps
  extends Omit<ComponentProps<'textarea'>, 'value' | 'ref'> {
  value: string
  controlRef: RefObject<HTMLTextAreaElement | null>
  lines: DownloadInputLine[]
  onCorrect: (line: DownloadInputLine, correction: SourceCorrection) => void
}

interface Marker {
  line: DownloadInputLine
  top: number
  right: number
  wrapped: boolean
}

export function UrlEditor({
  value,
  controlRef,
  lines,
  onCorrect,
  ...props
}: UrlEditorProps) {
  const mirrorRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<number | null>(null)
  const [markers, setMarkers] = useState<Marker[]>([])
  const [composing, setComposing] = useState(false)
  const oversized = lines.some(
    (line) =>
      line.analysis.status !== 'accepted' &&
      line.analysis.diagnostic.reason === 'tooManySources'
  )
  const enhanced = !oversized && !composing
  const display = useMemo(() => {
    if (oversized) return []
    const byLine = new Map(lines.map((line) => [line.line, line]))
    return value
      .split('\n')
      .map((raw, index) =>
        getUrlDisplayParts(raw.replace(/\r$/, ''), byLine.get(index))
      )
  }, [value, lines, oversized])

  const measure = useCallback(() => {
    const textarea = controlRef.current
    const mirror = mirrorRef.current
    if (!textarea || !mirror) return
    // Use the actual content width, including the platform's scrollbar gutter.
    mirror.style.width = `${textarea.clientWidth}px`
    mirror.style.transform = `translateY(${-textarea.scrollTop}px)`
    const lineHeight =
      Number.parseFloat(getComputedStyle(textarea).lineHeight) || 22
    // Overlay scrollbars on macOS occupy pixels without reducing clientWidth.
    const scrollbarWidth = Math.max(
      textarea.offsetWidth - textarea.clientWidth,
      textarea.scrollHeight > textarea.clientHeight ? 16 : 0
    )
    const next: Marker[] = []
    if (!composing) {
      for (const line of lines) {
        if (line.analysis.status === 'accepted') continue
        const row = mirror.children.item(line.line) as HTMLElement | null
        const center = oversized
          ? 12 + lineHeight / 2
          : row
            ? row.offsetTop + row.offsetHeight - lineHeight / 2
            : 0
        const top = center - textarea.scrollTop - 12
        if (top < 0 || top + 24 > textarea.clientHeight) continue
        next.push({
          line,
          top,
          right: scrollbarWidth + 8,
          wrapped: Boolean(row && row.offsetHeight > lineHeight),
        })
      }
    }
    setMarkers((previous) =>
      previous.length === next.length &&
      previous.every(
        (marker, i) =>
          marker.line === next[i].line &&
          marker.top === next[i].top &&
          marker.right === next[i].right &&
          marker.wrapped === next[i].wrapped
      )
        ? previous
        : next
    )
  }, [controlRef, lines, composing, oversized])

  useLayoutEffect(measure, [measure])
  useEffect(() => {
    const textarea = controlRef.current
    if (!textarea) return
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(measure)
    observer?.observe(textarea)
    document.fonts?.addEventListener('loadingdone', measure)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      document.fonts?.removeEventListener('loadingdone', measure)
      window.removeEventListener('resize', measure)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [controlRef, measure])

  return (
    <div className="url-editor" data-enhanced={enhanced}>
      <div
        className="url-editor-viewport"
        aria-hidden="true"
        style={{ visibility: enhanced ? undefined : 'hidden' }}
      >
        <div ref={mirrorRef} className="url-editor-mirror">
          {display.map((parts, index) => (
            // A line's position is its identity in this noninteractive mirror.
            // biome-ignore lint/suspicious/noArrayIndexKey: mirrors native textarea line positions
            <div key={index} className="url-editor-line" data-url-line={index}>
              {parts.length ? (
                parts.map((part) => (
                  <span key={part.start} className={`url-editor-${part.kind}`}>
                    {part.text}
                  </span>
                ))
              ) : (
                <br />
              )}
            </div>
          ))}
        </div>
      </div>
      <InputGroupTextarea
        {...props}
        ref={controlRef}
        value={value}
        dir="ltr"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="soft"
        className="url-editor-control"
        onScroll={() => {
          if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
          frameRef.current = requestAnimationFrame(() => {
            frameRef.current = null
            measure()
          })
        }}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
      />
      <div className="url-editor-viewport">
        {markers.map(({ line, ...position }) => (
          <UrlDiagnostic
            key={`${line.line}:${line.raw}`}
            line={line}
            {...position}
            disabled={props.disabled}
            onCorrect={onCorrect}
            onEdit={(line) => {
              const range = getUrlErrorRange(line)
              controlRef.current?.focus()
              controlRef.current?.setSelectionRange(
                line.start + (range?.start ?? 0),
                range ? line.start + range.end : line.end
              )
            }}
          />
        ))}
      </div>
    </div>
  )
}
