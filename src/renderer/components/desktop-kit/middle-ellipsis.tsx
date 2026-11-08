import { cn } from '@renderer/lib/utils'
import { getPathDisplayParts } from '@shared/lib/path-display'

/** Keep both ends visible without reversing path text or measuring layout. */
export function MiddleEllipsis({
  text,
  className,
  maxChars = 64,
  dir = 'ltr',
}: {
  text: string
  className?: string
  maxChars?: number
  dir?: 'ltr' | 'rtl' | 'auto'
}) {
  const { start, ellipsis, end } = getPathDisplayParts(text, maxChars)

  return (
    <span
      data-slot="middle-ellipsis"
      dir={dir}
      title={text}
      onCopy={(event) => {
        event.clipboardData.setData('text/plain', text)
        event.preventDefault()
      }}
      className={cn(
        'inline-flex min-w-0 max-w-full select-text align-bottom font-mono',
        className
      )}
    >
      <span className="sr-only">{text}</span>
      <span
        aria-hidden="true"
        className={cn(
          'min-w-0 shrink whitespace-pre',
          ellipsis ? 'overflow-hidden' : 'truncate'
        )}
      >
        {start}
      </span>
      {ellipsis && (
        <span aria-hidden="true" className="shrink-0">
          {ellipsis}
        </span>
      )}
      <span
        aria-hidden="true"
        className="flex min-w-0 shrink justify-end overflow-hidden"
      >
        <span className="shrink-0 whitespace-pre">{end}</span>
      </span>
    </span>
  )
}
