import { Button } from '@renderer/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@renderer/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import type { DownloadInputLine } from '@shared/lib/download-source-input'
import type { SourceCorrection } from '@shared/schemas/download-source'
import { CircleAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface UrlDiagnosticProps {
  line: DownloadInputLine
  top: number
  right: number
  wrapped: boolean
  disabled?: boolean
  onCorrect: (line: DownloadInputLine, correction: SourceCorrection) => void
  onEdit: (line: DownloadInputLine) => void
}

export function UrlDiagnostic({
  line,
  top,
  right,
  wrapped,
  disabled,
  onCorrect,
  onEdit,
}: UrlDiagnosticProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  if (line.analysis.status === 'accepted') return null
  const reason = t(`task.add.sourceErrors.${line.analysis.diagnostic.reason}`)
  const label = `${t('task.add.sourceLine', { line: line.line + 1 })}: ${reason}`
  const corrections =
    line.analysis.status === 'needsCorrection' ? line.analysis.corrections : []
  const button = (
    <button
      type="button"
      disabled={disabled}
      aria-label={label}
      data-url-diagnostic={line.line}
      className="url-editor-diagnostic pointer-events-auto absolute flex size-6 items-center justify-center rounded-sm text-destructive outline-none hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
      style={{ top, right }}
      // Keep blur-time hash expansion from moving the pointer's target.
      onMouseDown={(event) => event.preventDefault()}
    />
  )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip disabled={open}>
        <TooltipTrigger
          delay={300}
          render={
            corrections.length ? <PopoverTrigger render={button} /> : button
          }
          onClick={corrections.length ? undefined : () => onEdit(line)}
        >
          <CircleAlert className="size-3.5" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent
          side={wrapped ? 'bottom' : 'top'}
          align="end"
          sideOffset={6}
          className="max-w-[min(20rem,calc(100vw-2rem))] text-left leading-relaxed"
        >
          {label}
        </TooltipContent>
      </Tooltip>
      {corrections.length > 0 && (
        <PopoverContent
          data-url-correction=""
          side="bottom"
          align="end"
          className="w-80 max-w-[calc(100vw-2rem)] space-y-3 p-3"
          aria-label={label}
        >
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              {t('task.add.sourceLine', { line: line.line + 1 })}
            </p>
            <p className="text-sm">{reason}</p>
          </div>
          {corrections.map((correction) => (
            <div key={correction.action} className="space-y-2">
              <code className="block max-h-24 overflow-auto rounded-sm bg-muted p-2 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {correction.url}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() => {
                  setOpen(false)
                  onCorrect(line, correction)
                }}
              >
                {t(`task.add.sourceCorrections.${correction.action}`)}
              </Button>
            </div>
          ))}
        </PopoverContent>
      )}
    </Popover>
  )
}
