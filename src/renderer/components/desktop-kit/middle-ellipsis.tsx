import { cn } from '@renderer/lib/utils'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Keep both ends visible without reversing path text or measuring layout. */
export function MiddleEllipsis({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  const characters = Array.from(
    segmenter.segment(text),
    ({ segment }) => segment
  )
  const middle = Math.ceil(characters.length / 2)

  return (
    <span
      data-slot="middle-ellipsis"
      dir="ltr"
      title={text}
      className={cn(
        'inline-flex min-w-0 max-w-full align-bottom font-mono',
        className
      )}
    >
      <span className="sr-only">{text}</span>
      <span
        aria-hidden="true"
        className="min-w-0 shrink truncate whitespace-pre"
      >
        {characters.slice(0, middle).join('')}
      </span>
      <span
        aria-hidden="true"
        className="flex min-w-0 shrink justify-end overflow-hidden"
      >
        <span className="shrink-0 whitespace-pre">
          {characters.slice(middle).join('')}
        </span>
      </span>
    </span>
  )
}
