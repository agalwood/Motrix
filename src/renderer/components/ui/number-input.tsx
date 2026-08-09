import { Button } from '@renderer/components/ui/button'
import { ButtonGroup } from '@renderer/components/ui/button-group'
import { Input } from '@renderer/components/ui/input'
import { cn } from '@renderer/lib/utils'
import { Minus, Plus } from 'lucide-react'

export interface NumberInputProps {
  value: number | undefined
  onChange: (value: number | undefined) => void
  min?: number
  max?: number
  step?: number
  fallback?: number
  size?: 'default' | 'sm'
  className?: string
  id?: string
  name?: string
  disabled?: boolean
  placeholder?: string
  'aria-invalid'?: boolean
  'aria-describedby'?: string
  'aria-label'?: string
  onBlur?: React.FocusEventHandler<HTMLInputElement>
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  fallback,
  size = 'sm',
  className,
  id,
  name,
  disabled,
  placeholder,
  onBlur,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedby,
  'aria-label': ariaLabel,
}: NumberInputProps) {
  const atMin = value !== undefined && min !== undefined && value <= min
  const atMax = value !== undefined && max !== undefined && value >= max

  const adjust = (delta: number) => {
    const base = value ?? fallback ?? min ?? 0
    let next = base + delta
    if (min !== undefined) next = Math.max(min, next)
    if (max !== undefined) next = Math.min(max, next)
    onChange(next)
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
    if (raw === '') {
      onChange(fallback)
      return
    }
    const parsed = Number(raw)
    onChange(Number.isNaN(parsed) ? fallback : parsed)
  }

  const inputH = size === 'sm' ? 'h-8' : 'h-9'
  const btnSize = size === 'sm' ? 'icon-sm' : 'icon'

  return (
    <ButtonGroup className={className}>
      <Input
        type="number"
        id={id}
        name={name}
        disabled={disabled}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        value={value === undefined ? '' : value}
        onChange={handleInputChange}
        onBlur={onBlur}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedby}
        aria-label={ariaLabel}
        className={cn(
          'font-mono',
          inputH,
          '[appearance:textfield]',
          '[&::-webkit-inner-spin-button]:m-0 [&::-webkit-inner-spin-button]:appearance-none',
          '[&::-webkit-outer-spin-button]:m-0 [&::-webkit-outer-spin-button]:appearance-none'
        )}
      />
      <Button
        variant="outline"
        size={btnSize}
        type="button"
        aria-label="Decrement"
        onClick={() => adjust(-step)}
        disabled={disabled || atMin}
      >
        <Minus />
      </Button>
      <Button
        variant="outline"
        size={btnSize}
        type="button"
        aria-label="Increment"
        onClick={() => adjust(step)}
        disabled={disabled || atMax}
      >
        <Plus />
      </Button>
    </ButtonGroup>
  )
}
