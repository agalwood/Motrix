import { Check, Copy } from 'lucide-react'
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import { Button } from '@/components/ui/button'

type CopyButtonProps = Omit<
  ComponentProps<typeof Button>,
  'onClick' | 'content'
> & {
  content?: string | (() => string | Promise<string>)
  iconPosition?: 'start' | 'end'
  onClick?: () => void | Promise<void>
  resetMs?: number
  copiedLabel?: string
}

/** Adapted from Motrix's desktop-kit CopyButton for extension UI primitives. */
export function CopyButton({
  content,
  iconPosition = 'start',
  onClick,
  resetMs = 1500,
  copiedLabel,
  children,
  disabled,
  ...rest
}: CopyButtonProps): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const busyRef = useRef(false)
  const mountedRef = useRef(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handleClick = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setCopying(true)
    setCopied(false)
    if (timerRef.current) clearTimeout(timerRef.current)
    try {
      if (content !== undefined) {
        const text = typeof content === 'function' ? await content() : content
        // String content reaches writeText in the original click activation.
        await navigator.clipboard.writeText(text)
      } else if (onClick) {
        await onClick()
      } else {
        return
      }
    } catch {
      return
    } finally {
      busyRef.current = false
      if (mountedRef.current) setCopying(false)
    }

    if (!mountedRef.current) return
    setCopied(true)
    timerRef.current = setTimeout(() => {
      setCopied(false)
      timerRef.current = null
    }, resetMs)
  }, [content, onClick, resetMs])

  const Icon = copied ? Check : Copy
  const label = copied && copiedLabel ? copiedLabel : rest['aria-label']

  return (
    <Button
      type="button"
      {...rest}
      disabled={disabled || copying}
      aria-label={label}
      title={copied && copiedLabel ? copiedLabel : rest.title}
      onClick={() => void handleClick()}
    >
      {iconPosition === 'start' && <Icon aria-hidden="true" />}
      {children}
      {iconPosition === 'end' && <Icon aria-hidden="true" />}
      {copiedLabel && (
        <span role="status" className="sr-only">
          {copied ? copiedLabel : ''}
        </span>
      )}
    </Button>
  )
}
