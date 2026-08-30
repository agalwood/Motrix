import { Button } from '@renderer/components/ui/button'
import { Check, Copy } from 'lucide-react'
import {
  type ComponentProps,
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
}

export function CopyButton({
  content,
  iconPosition = 'start',
  onClick,
  resetMs = 1500,
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
    } catch {
      return
    }

    setCopied(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      setCopied(false)
      timerRef.current = null
    }, resetMs)
  }, [content, onClick, resetMs])

  const Icon = copied ? Check : Copy

  return (
    <Button type="button" onClick={handleClick} {...rest}>
      {iconPosition === 'start' && <Icon />}
      {children}
      {iconPosition === 'end' && <Icon />}
    </Button>
  )
}
