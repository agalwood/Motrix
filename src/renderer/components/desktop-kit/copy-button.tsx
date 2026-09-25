import { CheckIcon, CopyIcon } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'

type CopyButtonProps = Omit<
  ComponentProps<typeof Button>,
  'onClick' | 'content'
> & {
  content?: string | (() => string | Promise<string>)
  iconPosition?: 'start' | 'end'
  onClick?: () => void | Promise<void>
  resetMs?: number
  copiedLabel?: ReactNode
  onCopyError?: (error: unknown) => void
}

export function CopyButton({
  content,
  iconPosition = 'start',
  onClick,
  resetMs = 1500,
  copiedLabel,
  onCopyError,
  children,
  ...rest
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handleClick = useCallback(async () => {
    try {
      if (content !== undefined) {
        const text = typeof content === 'function' ? await content() : content
        await navigator.clipboard.writeText(text)
      } else if (onClick) {
        await onClick()
      } else {
        return
      }
    } catch (error) {
      onCopyError?.(error)
      return
    }

    setCopied(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      setCopied(false)
      timerRef.current = null
    }, resetMs)
  }, [content, onClick, onCopyError, resetMs])

  const Icon = copied ? CheckIcon : CopyIcon

  return (
    <Button type="button" onClick={handleClick} {...rest}>
      {iconPosition === 'start' && <Icon />}
      {copiedLabel ? (
        <span className="grid">
          <span
            aria-hidden="true"
            className="invisible col-start-1 row-start-1"
          >
            {children}
          </span>
          <span
            aria-hidden="true"
            className="invisible col-start-1 row-start-1"
          >
            {copiedLabel}
          </span>
          <span aria-live="polite" className="col-start-1 row-start-1">
            {copied ? copiedLabel : children}
          </span>
        </span>
      ) : (
        children
      )}
      {iconPosition === 'end' && <Icon />}
    </Button>
  )
}
