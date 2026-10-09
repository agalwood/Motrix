import { useReducedMotion } from '@renderer/lib/reduced-motion'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import './import-motion.css'

const MotionContext = createContext(false)
const feedback = {
  count: { transform: 'translateY(5px)', opacity: 0.5, duration: 180 },
  stage: { transform: 'translateY(6px)', opacity: 0, duration: 220 },
  task: {
    transform: 'translateY(-6px) scale(.94)',
    opacity: 0.4,
    duration: 240,
  },
  success: { transform: 'scale(.9)', opacity: 0.3, duration: 280 },
} as const

export function ImportMotionScope({
  active,
  children,
}: {
  active: boolean
  children: ReactNode
}) {
  const reducedMotion = useReducedMotion()
  const [keyboard, setKeyboard] = useState(false)
  const [visible, setVisible] = useState(!document.hidden)
  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])
  const enabled = active && visible && !reducedMotion && !keyboard
  return (
    <MotionContext value={enabled}>
      <div
        className="migration-motion h-full min-h-0 bg-background text-foreground"
        data-motion={enabled ? 'on' : 'off'}
        onKeyDownCapture={() => setKeyboard(true)}
        onPointerDownCapture={() => setKeyboard(false)}
      >
        {children}
      </div>
    </MotionContext>
  )
}

/** Values render immediately. Only the presentation responds to a real change. */
function useImportFeedback<T extends HTMLElement = HTMLSpanElement>(
  value: number | string,
  kind: keyof typeof feedback,
  enter = false
) {
  const enabled = useContext(MotionContext)
  const ref = useRef<T>(null)
  const previous = useRef<number | string>(value)
  const mounted = useRef(false)
  const animation = useRef<Animation | null>(null)
  useLayoutEffect(() => {
    const changed = previous.current !== value || (!mounted.current && enter)
    previous.current = value
    mounted.current = true
    const element = ref.current
    if (!enabled) {
      animation.current?.cancel()
      animation.current = null
      return
    }
    if (!changed || !element?.animate) return
    const preset = feedback[kind]
    // Re-target a rapid change from its visible position, without queuing effects.
    const current =
      animation.current?.playState === 'running'
        ? getComputedStyle(element)
        : null
    const from = {
      transform: current?.transform ?? preset.transform,
      opacity: current?.opacity ?? preset.opacity,
    }
    animation.current?.cancel()
    const next = element.animate([from, { transform: 'none', opacity: 1 }], {
      duration: preset.duration,
      easing: 'cubic-bezier(0.23, 1, 0.32, 1)',
    })
    animation.current = next
    next.onfinish = () => {
      if (animation.current === next) animation.current = null
    }
  }, [value, kind, enter, enabled])
  useLayoutEffect(() => () => animation.current?.cancel(), [])
  return ref
}

export function ImportCount({ value }: { value: number }) {
  const ref = useImportFeedback(value, 'count')
  return (
    <span ref={ref} className="inline-block tabular-nums">
      {value}
    </span>
  )
}

export function ImportStageContent({ children }: { children: ReactNode }) {
  const ref = useImportFeedback<HTMLDivElement>('stage', 'stage', true)
  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-col">
      {children}
    </div>
  )
}

export function ImportResultMark({
  success,
  children,
}: {
  success: boolean
  children: ReactNode
}) {
  const ref = useImportFeedback('result', 'success', success)
  return (
    <span
      ref={ref}
      className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-border/50 bg-muted shadow-xs"
    >
      {children}
    </span>
  )
}
