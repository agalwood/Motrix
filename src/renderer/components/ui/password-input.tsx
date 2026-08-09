import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@renderer/components/ui/input-group'
import { cn } from '@renderer/lib/utils'
import { Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'

export interface PasswordInputProps {
  value: string
  onChange: (value: string) => void
  onBlur?: React.FocusEventHandler<HTMLInputElement>
  showPasswordLabel?: string
  hidePasswordLabel?: string
  placeholder?: string
  disabled?: boolean
  id?: string
  name?: string
  className?: string
  autoComplete?: string
  'aria-invalid'?: boolean
  'aria-describedby'?: string
}

export function PasswordInput({
  value,
  onChange,
  onBlur,
  showPasswordLabel = 'Show password',
  hidePasswordLabel = 'Hide password',
  placeholder,
  disabled,
  id,
  name,
  className,
  autoComplete = 'off',
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: PasswordInputProps) {
  const [revealed, setRevealed] = useState(false)
  return (
    <InputGroup className={cn('h-8', className)}>
      <InputGroupInput
        id={id}
        name={name}
        type={revealed ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete={autoComplete}
        aria-invalid={ariaInvalid}
        aria-describedby={ariaDescribedBy}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          variant="ghost"
          disabled={disabled}
          aria-label={revealed ? hidePasswordLabel : showPasswordLabel}
          aria-pressed={revealed}
          onClick={() => setRevealed((v) => !v)}
        >
          {revealed ? <EyeOff /> : <Eye />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}
