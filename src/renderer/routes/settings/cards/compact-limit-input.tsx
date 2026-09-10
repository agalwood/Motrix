import { Button } from '@renderer/components/ui/button'
import { ButtonGroup } from '@renderer/components/ui/button-group'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@renderer/components/ui/input-group'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { Infinity as InfinityIcon, RotateCcw } from 'lucide-react'
import { type ComponentProps, forwardRef, useState } from 'react'

type ZeroAction = 'unlimited' | 'inherit'

type CompactLimitInputProps = Omit<
  ComponentProps<typeof InputGroupInput>,
  'type' | 'value' | 'onChange'
> & {
  value: number
  onValueChange: (value: number) => void
  unit: string
  zeroLabel: string
  resetLabel: string
  zeroAction?: ZeroAction
}

export const CompactLimitInput = forwardRef<
  HTMLInputElement,
  CompactLimitInputProps
>(function CompactLimitInput(
  {
    value,
    onValueChange,
    unit,
    zeroLabel,
    resetLabel,
    zeroAction = 'unlimited',
    onKeyDown,
    onBlur,
    ...props
  },
  ref
) {
  // Preserve partial decimals while editing; the parent rounds to whole bytes.
  const [draft, setDraft] = useState<{ text: string; unit: string } | null>(
    null
  )
  const zero = value <= 0
  const ResetIcon = zeroAction === 'inherit' ? RotateCcw : InfinityIcon

  return (
    <ButtonGroup className="w-40 shrink-0">
      {!zero && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  aria-label={resetLabel}
                  onClick={() => {
                    setDraft(null)
                    onValueChange(0)
                  }}
                >
                  <ResetIcon aria-hidden />
                </Button>
              }
            />
            <TooltipContent>{resetLabel}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <InputGroup className="h-8 min-w-0 w-auto flex-1 bg-background">
        <InputGroupInput
          {...props}
          ref={ref}
          data-slot="input-group-control"
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          autoComplete="off"
          aria-valuemin={0}
          aria-valuenow={Math.max(0, value)}
          aria-valuetext={zero ? zeroLabel : `${value} ${unit}`}
          className="h-8 min-w-0 px-2 text-right tabular-nums placeholder:text-right placeholder:text-xs [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          value={draft?.unit === unit ? draft.text : zero ? '' : value}
          placeholder={zeroLabel}
          onChange={(event) => {
            setDraft({ text: event.target.value, unit })
            const nextValue = Number(event.target.value)
            onValueChange(
              Number.isFinite(nextValue) ? Math.max(0, nextValue) : 0
            )
          }}
          onBlur={(event) => {
            setDraft(null)
            onBlur?.(event)
          }}
          onKeyDown={(event) => {
            onKeyDown?.(event)
            if (
              event.defaultPrevented ||
              (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')
            ) {
              return
            }
            event.preventDefault()
            setDraft(null)
            const delta = event.key === 'ArrowUp' ? 1 : -1
            onValueChange(Math.max(0, value + delta))
          }}
        />
        {!zero && (
          <InputGroupAddon align="inline-end" className="pr-2">
            <InputGroupText className="text-[11px]">{unit}</InputGroupText>
          </InputGroupAddon>
        )}
      </InputGroup>
    </ButtonGroup>
  )
})
