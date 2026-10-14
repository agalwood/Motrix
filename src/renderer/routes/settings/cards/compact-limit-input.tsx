import { ResetIcon, UnlimitedIcon } from '@renderer/components/icons'
import { Button } from '@renderer/components/ui/button'
import { ButtonGroup } from '@renderer/components/ui/button-group'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@renderer/components/ui/input-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip'
import { useByteFormat } from '@renderer/hooks/use-byte-format'
import type { SpeedLimitUnit } from '@shared/schemas/speed-limit-units'
import { type ComponentProps, forwardRef, useState } from 'react'

type ZeroAction = 'unlimited' | 'inherit'

type CompactLimitInputProps = Omit<
  ComponentProps<typeof InputGroupInput>,
  'type' | 'value' | 'onChange'
> & {
  value: number
  onValueChange: (value: number) => void
  magnitude: SpeedLimitUnit
  onMagnitudeChange: (value: SpeedLimitUnit) => void
  unitLabel: string
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
    magnitude,
    onMagnitudeChange,
    unitLabel,
    zeroLabel,
    resetLabel,
    zeroAction = 'unlimited',
    onKeyDown,
    onBlur,
    ...props
  },
  ref
) {
  const { unitSystem, formatByteUnit } = useByteFormat()
  const kiloByte = unitSystem === 'binary' ? 1024 : 1000
  const scale = magnitude === 'mega' ? kiloByte ** 2 : kiloByte
  const units = {
    kilo: formatByteUnit(unitSystem === 'binary' ? 'KiB' : 'KB', true),
    mega: formatByteUnit(unitSystem === 'binary' ? 'MiB' : 'MB', true),
  }
  const unit = units[magnitude]
  // Byte-level display precision avoids long binary rounding tails (1.1 MiB/s
  // rounds to whole bytes). This formatted value is never committed on blur.
  const displayValue = Number(
    (value / scale).toFixed(magnitude === 'mega' ? 6 : 3)
  )
  // Keep bytes as the source of truth: selecting a unit never writes a value.
  // Preserve partial decimals until blur, but discard drafts after external edits.
  const [draft, setDraft] = useState<{
    text: string
    scale: number
    bytes: number
  } | null>(null)
  const toBytes = (amount: number) => {
    const bytes = Math.round(amount * scale)
    // A positive sub-byte limit must not silently become unlimited. Keep tiny
    // negatives invalid too, instead of rounding them into the zero sentinel.
    return amount > 0
      ? Math.max(1, bytes)
      : amount < 0
        ? Math.min(-1, bytes)
        : bytes
  }
  const zero = value === 0
  const ZeroActionIcon = zeroAction === 'inherit' ? ResetIcon : UnlimitedIcon

  return (
    <ButtonGroup className="w-42 shrink-0">
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
                  <ZeroActionIcon aria-hidden />
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
          aria-valuenow={
            Number.isFinite(displayValue) ? displayValue : undefined
          }
          aria-valuetext={zero ? zeroLabel : `${displayValue} ${unit}`}
          className="h-8 min-w-0 px-2 text-end tabular-nums placeholder:text-end placeholder:text-xs [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          value={
            draft?.scale === scale && Object.is(draft.bytes, value)
              ? draft.text
              : zero || !Number.isFinite(value)
                ? ''
                : displayValue
          }
          placeholder={zeroLabel}
          onChange={(event) => {
            const bytes = toBytes(
              event.target.value === '' ? 0 : event.target.valueAsNumber
            )
            setDraft({ text: event.target.value, scale, bytes })
            onValueChange(bytes)
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
            onValueChange(toBytes(Math.max(0, value / scale + delta)))
          }}
        />
        <InputGroupAddon
          align="inline-end"
          className="shrink-0 py-0 pe-0 has-[>button]:me-0"
        >
          <Select
            value={magnitude}
            items={units}
            disabled={props.disabled}
            onValueChange={(next) => {
              if (next !== 'kilo' && next !== 'mega') return
              setDraft(null)
              onMagnitudeChange(next)
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label={unitLabel}
              className="h-7 w-13 shrink-0 justify-end gap-0.5 border-0 px-0.5 text-[11px] shadow-none [&_svg]:size-3"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem value="kilo">{units.kilo}</SelectItem>
              <SelectItem value="mega">{units.mega}</SelectItem>
            </SelectContent>
          </Select>
        </InputGroupAddon>
      </InputGroup>
    </ButtonGroup>
  )
})
